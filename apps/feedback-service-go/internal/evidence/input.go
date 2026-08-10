package evidence

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"math"
	"mime/multipart"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

var pngSignature = []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}

// DecodeBase64 はKotlinのBase64.getDecoder相当としてwhitespaceを許さず、padding有無の両方を受理する。
func DecodeBase64(raw string, maximumBytes int64) ([]byte, error) {
	if maximumBytes <= 0 {
		return nil, invalid("evidence上限が不正です")
	}
	if strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
		return nil, invalid("dataBase64が不正です")
	}
	if int64(len(raw)) > ((maximumBytes+2)/3)*4+4 {
		return nil, tooLarge(maximumBytes)
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		data, err = base64.RawStdEncoding.DecodeString(raw)
	}
	if err != nil {
		return nil, invalid("dataBase64が不正です")
	}
	if int64(len(data)) > maximumBytes {
		return nil, tooLarge(maximumBytes)
	}
	return data, nil
}

// Prepare はdecoded evidenceを検証し、SHA-256を含むmetadataを生成する。
func Prepare(input Input, maximumBytes int64) (Attachment, error) {
	if maximumBytes <= 0 {
		return Attachment{}, invalid("evidence上限が不正です")
	}
	if input.ContentType != "image/png" && input.ContentType != "image/webp" {
		return Attachment{}, invalid("evidence contentType が不正です")
	}
	if len(input.Data) == 0 {
		return Attachment{}, invalid("evidence が空です")
	}
	if int64(len(input.Data)) > maximumBytes {
		return Attachment{}, tooLarge(maximumBytes)
	}
	if input.ViewportWidth < 1 || input.ViewportHeight < 1 || input.CapturedAt.IsZero() ||
		input.PixelRatio < 0.1 || input.PixelRatio > 8 || math.IsNaN(input.PixelRatio) || math.IsInf(input.PixelRatio, 0) {
		return Attachment{}, invalid("evidence の viewport または pixelRatio が不正です")
	}
	if !matchesContentType(input.ContentType, input.Data) {
		return Attachment{}, invalid("evidence の内容が contentType と一致しません")
	}
	hash := sha256Bytes(input.Data)
	return Attachment{
		ContentType: input.ContentType, ByteSize: int64(len(input.Data)), SHA256: hex.EncodeToString(hash[:]),
		ViewportWidth: input.ViewportWidth, ViewportHeight: input.ViewportHeight,
		PixelRatio: input.PixelRatio, CapturedAt: input.CapturedAt,
	}, nil
}

// ValidateAttachment はtransactionへ渡すstaged metadataのDB制約相当を検証する。
func ValidateAttachment(attachment Attachment) error {
	if objectstore.ValidateKey(attachment.ObjectKey) != nil ||
		(attachment.ContentType != "image/png" && attachment.ContentType != "image/webp") ||
		attachment.ByteSize <= 0 || attachment.ViewportWidth <= 0 || attachment.ViewportHeight <= 0 ||
		attachment.PixelRatio < 0.1 || attachment.PixelRatio > 8 || math.IsNaN(attachment.PixelRatio) ||
		math.IsInf(attachment.PixelRatio, 0) || attachment.CapturedAt.IsZero() || len(attachment.SHA256) != 64 {
		return invalid("evidence metadataが不正です")
	}
	decoded, err := hex.DecodeString(attachment.SHA256)
	if err != nil || len(decoded) != sha256.Size || strings.ToLower(attachment.SHA256) != attachment.SHA256 {
		return invalid("evidence SHA-256が不正です")
	}
	return nil
}

// DecodeMultipart はfile part `evidence` と4個のmetadata fieldだけを受理するstrict decoderである。
func DecodeMultipart(reader io.Reader, boundary string, maximumBytes int64) (Input, error) {
	if strings.TrimSpace(boundary) == "" || maximumBytes <= 0 {
		return Input{}, invalid("multipart boundaryまたはevidence上限が不正です")
	}
	parts := multipart.NewReader(reader, boundary)
	values := make(map[string]string, 4)
	var result Input
	fileSeen := false
	for {
		part, err := parts.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return Input{}, invalid("multipart bodyが不正です")
		}
		name := part.FormName()
		if name == "evidence" {
			if fileSeen || part.FileName() == "" {
				_ = part.Close()
				return Input{}, invalid("evidence file partが重複または不正です")
			}
			fileSeen = true
			result.ContentType = part.Header.Get("Content-Type")
			data, err := io.ReadAll(io.LimitReader(part, maximumBytes+1))
			_ = part.Close()
			if err != nil {
				return Input{}, invalid("evidence fileを読み取れません")
			}
			if int64(len(data)) > maximumBytes {
				return Input{}, tooLarge(maximumBytes)
			}
			result.Data = data
			continue
		}
		if name != "viewportWidth" && name != "viewportHeight" && name != "pixelRatio" && name != "capturedAt" {
			_ = part.Close()
			return Input{}, invalid("未知のmultipart fieldがあります")
		}
		if _, exists := values[name]; exists || part.FileName() != "" {
			_ = part.Close()
			return Input{}, invalid("multipart fieldが重複または不正です")
		}
		value, err := io.ReadAll(io.LimitReader(part, 1025))
		_ = part.Close()
		if err != nil || len(value) > 1024 {
			return Input{}, invalid("multipart fieldが不正です")
		}
		values[name] = string(value)
	}
	if !fileSeen || len(values) != 4 {
		return Input{}, invalid("multipart evidence fieldが不足しています")
	}
	var err error
	if result.ViewportWidth, err = strconv.Atoi(values["viewportWidth"]); err != nil {
		return Input{}, invalid("viewportWidthが不正です")
	}
	if result.ViewportHeight, err = strconv.Atoi(values["viewportHeight"]); err != nil {
		return Input{}, invalid("viewportHeightが不正です")
	}
	if result.PixelRatio, err = strconv.ParseFloat(values["pixelRatio"], 64); err != nil {
		return Input{}, invalid("pixelRatioが不正です")
	}
	if result.CapturedAt, err = time.Parse(time.RFC3339Nano, values["capturedAt"]); err != nil {
		return Input{}, invalid("capturedAtが不正です")
	}
	if _, err := Prepare(result, maximumBytes); err != nil {
		return Input{}, err
	}
	return result, nil
}

func matchesContentType(contentType string, data []byte) bool {
	switch contentType {
	case "image/png":
		return len(data) >= len(pngSignature) && bytes.Equal(data[:len(pngSignature)], pngSignature)
	case "image/webp":
		return len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	default:
		return false
	}
}

func malformedIntegrity() error {
	return domainError(ErrIntegrity, "evidence.integrity_error", "evidence の整合性を確認できません")
}

func sha256Bytes(data []byte) [32]byte {
	return sha256.Sum256(data)
}
