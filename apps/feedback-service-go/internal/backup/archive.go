package backup

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

type manifestEntry struct {
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Rows   *int64 `json:"rows,omitempty"`
}

func WriteArchive(
	ctx context.Context,
	prepared PreparedArchive,
	evidenceStorage objectstore.Store,
	target string,
	now func() time.Time,
) (ArchiveResult, error) {
	if evidenceStorage == nil || now == nil {
		return ArchiveResult{}, errors.New("backup archive dependencyが未設定です")
	}
	file, err := os.Create(target)
	if err != nil {
		return ArchiveResult{}, fmt.Errorf("backup archiveを作成できません: %w", err)
	}
	complete := false
	defer func() {
		_ = file.Close()
		if !complete {
			_ = os.Remove(target)
		}
	}()
	hashed := sha256.New()
	archive := zip.NewWriter(io.MultiWriter(file, hashed))
	entries := make(map[string]manifestEntry)
	entryOrder := make([]string, 0, len(prepared.CSVEntries)+len(prepared.EvidenceEntries))
	counts := make(map[string]int64, len(prepared.CSVEntries)+1)
	for _, csv := range prepared.CSVEntries {
		data := RenderArchiveCSV(csv.Header, csv.Rows)
		if err := writeEntry(archive, csv.Path, data); err != nil {
			return ArchiveResult{}, err
		}
		rows := int64(len(csv.Rows))
		entries[csv.Path] = manifestEntry{SHA256: SHA256Bytes(data), Bytes: int64(len(data)), Rows: &rows}
		entryOrder = append(entryOrder, csv.Path)
		counts[csv.Path] = rows
	}
	if prepared.IncludeEvidence {
		for _, evidence := range prepared.EvidenceEntries {
			object, err := evidenceStorage.Get(ctx, evidence.ObjectKey)
			if err != nil {
				return ArchiveResult{}, fmt.Errorf("backup evidenceを取得できません: %w", err)
			}
			data, readErr := io.ReadAll(object.Body)
			closeErr := object.Body.Close()
			if readErr != nil || closeErr != nil {
				return ArchiveResult{}, errors.Join(readErr, closeErr)
			}
			actual := SHA256Bytes(data)
			if actual != evidence.ExpectedSHA256 {
				return ArchiveResult{}, fmt.Errorf("%w: evidence checksum mismatch: %s", ErrIntegrity, evidence.ArchivePath)
			}
			if err := writeEntry(archive, evidence.ArchivePath, data); err != nil {
				return ArchiveResult{}, err
			}
			entries[evidence.ArchivePath] = manifestEntry{SHA256: actual, Bytes: int64(len(data))}
			entryOrder = append(entryOrder, evidence.ArchivePath)
		}
	}
	counts["evidence"] = 0
	if prepared.IncludeEvidence {
		counts["evidence"] = int64(len(prepared.EvidenceEntries))
	}
	manifest, err := buildManifest(prepared, entries, entryOrder, now().UTC())
	if err != nil {
		return ArchiveResult{}, err
	}
	if err := writeEntry(archive, "manifest.json", manifest); err != nil {
		return ArchiveResult{}, err
	}
	if err := archive.Close(); err != nil {
		return ArchiveResult{}, fmt.Errorf("backup ZIPを閉じられません: %w", err)
	}
	if err := file.Sync(); err != nil {
		return ArchiveResult{}, fmt.Errorf("backup archiveを同期できません: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return ArchiveResult{}, err
	}
	if err := file.Close(); err != nil {
		return ArchiveResult{}, err
	}
	complete = true
	return ArchiveResult{SHA256: hex.EncodeToString(hashed.Sum(nil)), ByteSize: info.Size(), EntryCounts: counts}, nil
}

func RenderArchiveCSV(header []string, rows [][]*string) []byte {
	var output strings.Builder
	output.WriteString("\ufeff")
	writeArchiveCSVRow(&output, pointerRow(header))
	for _, row := range rows {
		writeArchiveCSVRow(&output, row)
	}
	return []byte(output.String())
}

func pointerRow(values []string) []*string {
	result := make([]*string, len(values))
	for index := range values {
		value := values[index]
		result[index] = &value
	}
	return result
}

func writeArchiveCSVRow(output *strings.Builder, row []*string) {
	for index, value := range row {
		if index > 0 {
			output.WriteByte(',')
		}
		raw := ""
		if value != nil {
			raw = *value
		}
		raw = EscapeSpreadsheet(raw)
		output.WriteByte('"')
		output.WriteString(strings.ReplaceAll(raw, `"`, `""`))
		output.WriteByte('"')
	}
	output.WriteString("\r\n")
}

func EscapeSpreadsheet(value string) string {
	for _, character := range value {
		if character <= 0x20 {
			continue
		}
		if character == '=' || character == '+' || character == '-' || character == '@' {
			return "'" + value
		}
		break
	}
	return value
}

func writeEntry(archive *zip.Writer, name string, data []byte) error {
	header := &zip.FileHeader{Name: name, Method: zip.Deflate}
	header.Modified = time.Unix(0, 0).UTC()
	writer, err := archive.CreateHeader(header)
	if err != nil {
		return fmt.Errorf("backup ZIP entryを作成できません: %w", err)
	}
	if _, err := writer.Write(data); err != nil {
		return fmt.Errorf("backup ZIP entryを書けません: %w", err)
	}
	return nil
}

func buildManifest(
	prepared PreparedArchive,
	entries map[string]manifestEntry,
	entryOrder []string,
	generatedAt time.Time,
) ([]byte, error) {
	var output bytes.Buffer
	output.WriteByte('{')
	fields := []struct {
		name  string
		value any
	}{
		{"schemaVersion", "1"}, {"runId", prepared.RunID}, {"kind", prepared.Kind},
		{"scheduledFor", prepared.ScheduledFor}, {"generatedAt", javaInstant(generatedAt)},
		{"tenantKey", prepared.TenantKey}, {"applicationKey", prepared.ApplicationKey},
		{"environmentKey", prepared.EnvironmentKey}, {"externalWorkspaceKey", prepared.ExternalWorkspaceKey},
		{"fromChangeSequenceExclusive", prepared.FromChangeSequence}, {"toChangeSequenceInclusive", prepared.ToChangeSequence},
		{"fromAuditSequenceExclusive", prepared.FromAuditSequence}, {"toAuditSequenceInclusive", prepared.ToAuditSequence},
		{"historyCoverageStartedAt", prepared.HistoryCoverageStartedAt}, {"includeEvidence", prepared.IncludeEvidence},
	}
	for index, field := range fields {
		if index > 0 {
			output.WriteByte(',')
		}
		writeJSONField(&output, field.name, field.value)
	}
	output.WriteString(`,"counts":{`)
	for index, csv := range prepared.CSVEntries {
		if index > 0 {
			output.WriteByte(',')
		}
		writeJSONField(&output, csv.Path, len(csv.Rows))
	}
	if len(prepared.CSVEntries) > 0 {
		output.WriteByte(',')
	}
	evidenceCount := 0
	if prepared.IncludeEvidence {
		evidenceCount = len(prepared.EvidenceEntries)
	}
	writeJSONField(&output, "evidence", evidenceCount)
	output.WriteString(`},"entries":{`)
	for index, name := range entryOrder {
		if index > 0 {
			output.WriteByte(',')
		}
		nameJSON, _ := json.Marshal(name)
		metadataJSON, err := json.Marshal(entries[name])
		if err != nil {
			return nil, err
		}
		output.Write(nameJSON)
		output.WriteByte(':')
		output.Write(metadataJSON)
	}
	output.WriteString("}}")
	return output.Bytes(), nil
}

func writeJSONField(output *bytes.Buffer, name string, value any) {
	nameJSON, _ := json.Marshal(name)
	valueJSON, _ := json.Marshal(value)
	output.Write(nameJSON)
	output.WriteByte(':')
	output.Write(valueJSON)
}

func VerifyArchive(path string) bool {
	return verifyArchive(path) == nil
}

func verifyArchive(path string) error {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer archive.Close()
	var manifestFile *zip.File
	for _, file := range archive.File {
		if file.Name == "manifest.json" {
			manifestFile = file
			break
		}
	}
	if manifestFile == nil || manifestFile.UncompressedSize64 > 4*1024*1024 {
		return ErrIntegrity
	}
	manifestBytes, err := readZipEntry(manifestFile, int64(manifestFile.UncompressedSize64))
	if err != nil {
		return err
	}
	var manifest struct {
		Entries map[string]manifestEntry `json:"entries"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil || manifest.Entries == nil {
		return ErrIntegrity
	}
	if len(archive.File) != len(manifest.Entries)+1 {
		return ErrIntegrity
	}
	seen := make(map[string]struct{}, len(archive.File))
	for _, file := range archive.File {
		if _, duplicate := seen[file.Name]; duplicate {
			return ErrIntegrity
		}
		seen[file.Name] = struct{}{}
		if file.Name == "manifest.json" {
			continue
		}
		metadata, ok := manifest.Entries[file.Name]
		if !ok || metadata.Bytes < 0 || file.UncompressedSize64 != uint64(metadata.Bytes) {
			return ErrIntegrity
		}
		data, err := readZipEntry(file, metadata.Bytes)
		if err != nil || SHA256Bytes(data) != metadata.SHA256 {
			return ErrIntegrity
		}
	}
	return nil
}

func readZipEntry(file *zip.File, expected int64) ([]byte, error) {
	reader, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, expected+1))
	if err != nil || int64(len(data)) != expected {
		return nil, ErrIntegrity
	}
	return data, nil
}

func SHA256Bytes(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func SHA256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
