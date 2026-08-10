package connector

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/cryptoutil"
)

const (
	maximumDeliveryBody        = 256 * 1024
	maximumDeliveryIDLineBytes = 200
)

type RuntimeSettings struct {
	Provider     string
	DisplayName  string
	SharedSecret string
}

type ReferenceDispatcher interface {
	Dispatch(context.Context, DeliveryRequestV1) error
}

type DeliveryIDStore interface {
	Contains(string) (bool, error)
	Add(string) error
}

// NewRuntime はConnector Protocol v1 server用のHTTP handlerを返す。
func NewRuntime(
	settings RuntimeSettings,
	dispatcher ReferenceDispatcher,
	received DeliveryIDStore,
	now Clock,
) (http.Handler, error) {
	if _, ok := map[string]struct{}{"webhook": {}, "teams": {}, "slack": {}, "smtp-mail": {}}[settings.Provider]; !ok {
		return nil, errors.New("connector providerが不正です")
	}
	if strings.TrimSpace(settings.DisplayName) == "" || javaStringLength(settings.DisplayName) > 200 {
		return nil, errors.New("connector displayNameが不正です")
	}
	if javaStringLength(settings.SharedSecret) < 32 {
		return nil, errors.New("connector shared secretは32文字以上必要です")
	}
	if dispatcher == nil || received == nil {
		return nil, errors.New("connector runtime依存が未設定です")
	}
	if now == nil {
		now = time.Now
	}
	runtime := &runtimeHandler{
		settings: settings, dispatcher: dispatcher, received: received,
		now: now, gates: make(map[string]*executionEntry),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /connector/v1/manifest", runtime.manifest)
	mux.HandleFunc("GET /health/live", health("live"))
	mux.HandleFunc("GET /health/ready", health("ready"))
	mux.HandleFunc("POST /connector/v1/deliveries", runtime.deliver)
	return mux, nil
}

type runtimeHandler struct {
	settings   RuntimeSettings
	dispatcher ReferenceDispatcher
	received   DeliveryIDStore
	now        Clock
	gateMu     sync.Mutex
	gates      map[string]*executionEntry
}

type executionEntry struct {
	mutex sync.Mutex
	users int
}

func (h *runtimeHandler) manifest(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, NewManifest(h.settings.Provider, h.settings.DisplayName, SupportedEvents))
}

func health(status string) http.HandlerFunc {
	return func(writer http.ResponseWriter, _ *http.Request) {
		writeJSON(writer, http.StatusOK, map[string]string{"status": status})
	}
}

func (h *runtimeHandler) deliver(writer http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maximumDeliveryBody+1))
	if err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	if len(body) > maximumDeliveryBody {
		http.Error(writer, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	if !cryptoutil.VerifyTimestampSignature(
		[]byte(h.settings.SharedSecret), request.Header.Get("X-Feedback-Timestamp"),
		request.Header.Get("X-Feedback-Signature"), body, h.now(), 5*time.Minute,
	) {
		http.Error(writer, "invalid signature", http.StatusUnauthorized)
		return
	}
	var delivery DeliveryRequestV1
	if err := decodeStrict(body, &delivery); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	if delivery.Kind != "delivery-request" || delivery.ProtocolVersion != ProtocolVersion {
		http.Error(writer, "unsupported protocol", http.StatusBadRequest)
		return
	}
	if request.Header.Get("X-Feedback-Delivery-Id") != delivery.DeliveryID {
		http.Error(writer, "delivery id mismatch", http.StatusBadRequest)
		return
	}
	if err := ValidateDelivery(delivery); err != nil {
		http.Error(writer, "event envelope mismatch", http.StatusBadRequest)
		return
	}

	entry := h.acquire(delivery.DeliveryID)
	entry.mutex.Lock()
	defer func() {
		entry.mutex.Unlock()
		h.release(delivery.DeliveryID, entry)
	}()
	duplicate, err := h.received.Contains(delivery.DeliveryID)
	if err != nil {
		http.Error(writer, "delivery failed", http.StatusBadGateway)
		return
	}
	if duplicate {
		h.writeResult(writer, http.StatusOK, delivery.DeliveryID, "duplicate")
		return
	}
	if err := h.dispatcher.Dispatch(request.Context(), delivery); err != nil {
		http.Error(writer, "delivery failed", http.StatusBadGateway)
		return
	}
	// 外部送信成功後に永続化できなければacceptedを返さない。再試行では
	// at-least-onceにより重複し得るため、reference destination側もIDを利用する。
	if err := h.received.Add(delivery.DeliveryID); err != nil {
		http.Error(writer, "delivery failed", http.StatusBadGateway)
		return
	}
	h.writeResult(writer, http.StatusAccepted, delivery.DeliveryID, "accepted")
}

func (h *runtimeHandler) acquire(id string) *executionEntry {
	h.gateMu.Lock()
	defer h.gateMu.Unlock()
	entry := h.gates[id]
	if entry == nil {
		entry = &executionEntry{}
		h.gates[id] = entry
	}
	entry.users++
	return entry
}

func (h *runtimeHandler) release(id string, entry *executionEntry) {
	h.gateMu.Lock()
	defer h.gateMu.Unlock()
	entry.users--
	if entry.users == 0 {
		delete(h.gates, id)
	}
}

func (h *runtimeHandler) writeResult(writer http.ResponseWriter, status int, id, result string) {
	writeJSON(writer, status, DeliveryResultV1{
		Kind: "delivery-result", ProtocolVersion: ProtocolVersion,
		DeliveryID: id, Status: result, ReceivedAt: javaInstant(h.now()),
	})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

type recentDeliveryIDs struct {
	maximum int
	values  map[string]struct{}
	order   []string
}

func newRecentDeliveryIDs(maximum int) *recentDeliveryIDs {
	return &recentDeliveryIDs{maximum: maximum, values: make(map[string]struct{}, maximum)}
}

func (r *recentDeliveryIDs) contains(id string) bool {
	_, ok := r.values[id]
	return ok
}

func (r *recentDeliveryIDs) add(id string) {
	if r.contains(id) {
		return
	}
	r.values[id] = struct{}{}
	r.order = append(r.order, id)
	if len(r.order) > r.maximum {
		delete(r.values, r.order[0])
		r.order = r.order[1:]
	}
}

type FileDeliveryIDStore struct {
	path   string
	memory *recentDeliveryIDs
	mutex  sync.Mutex
}

func NewFileDeliveryIDStore(path string, maximum int) (*FileDeliveryIDStore, error) {
	if maximum <= 0 {
		return nil, errors.New("idempotency maximumは正の値が必要です")
	}
	absolute, err := filepath.Abs(path)
	if err != nil || strings.TrimSpace(path) == "" {
		return nil, errors.New("idempotency file pathが不正です")
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return nil, fmt.Errorf("idempotency directoryを作成できません: %w", err)
	}
	store := &FileDeliveryIDStore{path: absolute, memory: newRecentDeliveryIDs(maximum)}
	file, err := os.Open(absolute)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, fmt.Errorf("idempotency fileを読み取れません: %w", err)
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64), maximumDeliveryIDLineBytes)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			continue
		}
		if uuid.Validate(line) != nil {
			return nil, errors.New("idempotency fileに不正なdelivery IDがあります")
		}
		store.memory.add(line)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("idempotency fileを走査できません: %w", err)
	}
	return store, nil
}

func (s *FileDeliveryIDStore) Contains(id string) (bool, error) {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.memory.contains(id), nil
}

func (s *FileDeliveryIDStore) Add(id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if uuid.Validate(id) != nil {
		return errors.New("delivery IDが不正です")
	}
	if s.memory.contains(id) {
		return nil
	}
	file, err := os.OpenFile(s.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("idempotency fileを開けません: %w", err)
	}
	if _, err = fmt.Fprintln(file, id); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return fmt.Errorf("idempotency IDを永続化できません: %w", err)
	}
	if closeErr != nil {
		return fmt.Errorf("idempotency fileを閉じられません: %w", closeErr)
	}
	s.memory.add(id)
	return nil
}
