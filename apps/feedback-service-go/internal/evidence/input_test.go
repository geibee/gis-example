package evidence

import (
	"bytes"
	"encoding/base64"
	"errors"
	"mime/multipart"
	"net/textproto"
	"strconv"
	"testing"
	"time"
)

func TestPrepare(t *testing.T) {
	t.Parallel()
	valid := validInput()
	tests := []struct {
		name string
		edit func(*Input)
		kind error
	}{
		{name: "valid"},
		{name: "unsupported MIME", edit: func(value *Input) { value.ContentType = "image/jpeg" }, kind: ErrInvalidInput},
		{name: "empty", edit: func(value *Input) { value.Data = nil }, kind: ErrInvalidInput},
		{name: "too large", edit: func(value *Input) { value.Data = append(value.Data, 1) }, kind: ErrTooLarge},
		{name: "magic mismatch", edit: func(value *Input) { value.Data[0] = 0 }, kind: ErrInvalidInput},
		{name: "viewport", edit: func(value *Input) { value.ViewportWidth = 0 }, kind: ErrInvalidInput},
		{name: "pixel ratio", edit: func(value *Input) { value.PixelRatio = 8.1 }, kind: ErrInvalidInput},
		{name: "captured at", edit: func(value *Input) { value.CapturedAt = time.Time{} }, kind: ErrInvalidInput},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			input := valid
			input.Data = append([]byte(nil), valid.Data...)
			if test.edit != nil {
				test.edit(&input)
			}
			attachment, err := Prepare(input, int64(len(valid.Data)))
			if test.kind == nil {
				if err != nil || attachment.ByteSize != int64(len(input.Data)) || len(attachment.SHA256) != 64 {
					t.Fatalf("Prepare() attachment=%+v error=%v", attachment, err)
				}
				return
			}
			if !errors.Is(err, test.kind) {
				t.Fatalf("Prepare() error=%v, want %v", err, test.kind)
			}
			var domain *Error
			if !errors.As(err, &domain) || domain.Code == "" {
				t.Fatalf("公開Errorを取得できません: %v", err)
			}
		})
	}
}

func TestDecodeBase64(t *testing.T) {
	t.Parallel()
	raw := []byte("01234567")
	tests := []struct {
		name string
		text string
		max  int64
		kind error
	}{
		{name: "padded", text: base64.StdEncoding.EncodeToString(raw), max: 8},
		{name: "unpadded", text: base64.RawStdEncoding.EncodeToString(raw), max: 8},
		{name: "whitespace rejected", text: base64.StdEncoding.EncodeToString(raw) + "\n", max: 8, kind: ErrInvalidInput},
		{name: "invalid alphabet", text: "%%%%", max: 8, kind: ErrInvalidInput},
		{name: "too large", text: base64.StdEncoding.EncodeToString(raw), max: 7, kind: ErrTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			decoded, err := DecodeBase64(test.text, test.max)
			if test.kind == nil && (!bytes.Equal(decoded, raw) || err != nil) {
				t.Fatalf("DecodeBase64()=%q error=%v", decoded, err)
			}
			if test.kind != nil && !errors.Is(err, test.kind) {
				t.Fatalf("DecodeBase64() error=%v, want %v", err, test.kind)
			}
		})
	}
}

func TestDecodeMultipart(t *testing.T) {
	t.Parallel()
	valid := validInput()
	body, boundary := multipartBody(t, valid, "")
	got, err := DecodeMultipart(bytes.NewReader(body), boundary, 1024)
	if err != nil {
		t.Fatalf("DecodeMultipart() error=%v", err)
	}
	if !bytes.Equal(got.Data, valid.Data) || got.ContentType != valid.ContentType || got.ViewportWidth != valid.ViewportWidth {
		t.Fatalf("DecodeMultipart()=%+v", got)
	}

	tests := []struct {
		name  string
		extra string
		max   int64
		kind  error
	}{
		{name: "unknown field", extra: "unknown", max: 1024, kind: ErrInvalidInput},
		{name: "duplicate field", extra: "viewportWidth", max: 1024, kind: ErrInvalidInput},
		{name: "too large", max: int64(len(valid.Data) - 1), kind: ErrTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			body, boundary := multipartBody(t, valid, test.extra)
			_, err := DecodeMultipart(bytes.NewReader(body), boundary, test.max)
			if !errors.Is(err, test.kind) {
				t.Fatalf("DecodeMultipart() error=%v, want %v", err, test.kind)
			}
		})
	}
}

func multipartBody(t *testing.T, input Input, extra string) ([]byte, string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="evidence"; filename="evidence.png"`)
	header.Set("Content-Type", input.ContentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write(input.Data)
	values := []struct{ name, value string }{
		{name: "viewportWidth", value: strconv.Itoa(input.ViewportWidth)},
		{name: "viewportHeight", value: strconv.Itoa(input.ViewportHeight)},
		{name: "pixelRatio", value: strconv.FormatFloat(input.PixelRatio, 'f', -1, 64)},
		{name: "capturedAt", value: input.CapturedAt.Format(time.RFC3339Nano)},
	}
	for _, value := range values {
		_ = writer.WriteField(value.name, value.value)
	}
	if extra != "" {
		_ = writer.WriteField(extra, "duplicate")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), writer.Boundary()
}

func validInput() Input {
	return Input{
		ContentType: "image/png", Data: append(append([]byte(nil), pngSignature...), []byte("payload")...),
		ViewportWidth: 1280, ViewportHeight: 720, PixelRatio: 2,
		CapturedAt: time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC),
	}
}
