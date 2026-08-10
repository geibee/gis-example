package backup

import (
	"bytes"
	"errors"
	"io"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/objectstore"
)

func TestReadStoredBackupRequiresExactSizeAndChecksum(t *testing.T) {
	t.Parallel()
	payload := []byte("backup-archive")
	metadata := StoredMetadata{ArchiveBytes: int64(len(payload)), ArchiveSHA256: SHA256Bytes(payload)}
	data, err := readStoredBackup(objectstore.Object{
		Size: int64(len(payload)), Body: io.NopCloser(bytes.NewReader(payload)),
	}, metadata)
	if err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("readStoredBackup() data=%q err=%v", data, err)
	}
	for name, object := range map[string]objectstore.Object{
		"metadata size mismatch": {
			Size: int64(len(payload) + 1), Body: io.NopCloser(bytes.NewReader(payload)),
		},
		"stream larger than metadata": {
			Size: -1, Body: io.NopCloser(bytes.NewReader(append(append([]byte(nil), payload...), 'x'))),
		},
		"stream shorter than metadata": {
			Size: -1, Body: io.NopCloser(bytes.NewReader(payload[:len(payload)-1])),
		},
	} {
		name, object := name, object
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := readStoredBackup(object, metadata); !errors.Is(err, ErrIntegrity) {
				t.Fatalf("readStoredBackup() error=%v", err)
			}
		})
	}
}
