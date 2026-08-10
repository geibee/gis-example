package objectstore

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"os"
	"path"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"

	serviceconfig "github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
)

const maximumObjectKeyBytes = 1000

var (
	ErrInvalidKey    = errors.New("object keyが不正です")
	ErrAlreadyExists = errors.New("objectは既に存在します")
	ErrNotFound      = errors.New("objectが見つかりません")
)

// Object はobject storageから読み取ったimmutable objectである。
type Object struct {
	Key          string
	ContentType  string
	Size         int64
	Body         io.ReadCloser
	LastModified time.Time
}

// Ref はretention/orphan sweepが必要とする最小metadataである。
type Ref struct {
	Key          string
	LastModified time.Time
}

// Store はevidence/export/backupが共有するobject単位のportである。
// 大容量成果物はPutReaderで全量heap化せずに保存する。
type Store interface {
	Put(context.Context, string, string, []byte) error
	PutReader(context.Context, string, string, io.Reader, int64) error
	Get(context.Context, string) (Object, error)
	Delete(context.Context, string) error
	List(context.Context, string) ([]Ref, error)
	CheckReadiness(context.Context) error
	Close() error
}

// NewStore は設定済みbackendをobject操作可能な形で生成する。
func NewStore(ctx context.Context, settings serviceconfig.StorageSettings) (Store, error) {
	switch settings.Mode {
	case serviceconfig.StorageModeLocal:
		return NewLocal(settings.LocalDirectory)
	case serviceconfig.StorageModeS3:
		return NewS3(ctx, settings)
	default:
		return nil, fmt.Errorf("未対応のobject storage modeです: %s", settings.Mode)
	}
}

// ValidateKey はDBへ永続化可能でfilesystem/S3の両方で同じ意味になるkeyだけを許可する。
func ValidateKey(key string) error {
	if key == "" || len(key) > maximumObjectKeyBytes || !utf8.ValidString(key) ||
		strings.HasPrefix(key, "/") || strings.HasSuffix(key, "/") ||
		strings.ContainsAny(key, "\\\x00") {
		return ErrInvalidKey
	}
	for _, segment := range strings.Split(key, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return ErrInvalidKey
		}
	}
	return nil
}

// ValidatePrefix は空prefixまたは末尾slashを含む安全なobject prefixを許可する。
func ValidatePrefix(prefix string) error {
	if prefix == "" {
		return nil
	}
	trimmed := strings.TrimSuffix(prefix, "/")
	if trimmed == "" {
		return ErrInvalidKey
	}
	return ValidateKey(trimmed)
}

func (storage *Local) Put(ctx context.Context, key string, contentType string, data []byte) error {
	return storage.PutReader(ctx, key, contentType, bytes.NewReader(data), int64(len(data)))
}

func (storage *Local) PutReader(
	ctx context.Context, key string, _ string, reader io.Reader, size int64,
) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	if reader == nil || size < 0 || size == math.MaxInt64 {
		return errors.New("object readerまたはsizeが不正です")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := os.OpenRoot(storage.root)
	if err != nil {
		return fmt.Errorf("local object storageを開けません: %w", err)
	}
	defer root.Close()
	if err := root.MkdirAll(path.Dir(key), 0o750); err != nil {
		return fmt.Errorf("object directoryを作成できません: %w", err)
	}
	file, err := root.OpenFile(key, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if errors.Is(err, fs.ErrExist) {
		return fmt.Errorf("%w: %s", ErrAlreadyExists, key)
	}
	if err != nil {
		return fmt.Errorf("objectを作成できません: %w", err)
	}
	complete := false
	defer func() {
		_ = file.Close()
		if !complete {
			_ = root.Remove(key)
		}
	}()

	written, err := io.Copy(file, io.LimitReader(&contextReader{ctx: ctx, value: reader}, size+1))
	if err != nil {
		return fmt.Errorf("objectを書き込めません: %w", err)
	}
	if written != size {
		return fmt.Errorf("object sizeが一致しません: got=%d want=%d", written, size)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("objectを同期できません: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("objectを閉じられません: %w", err)
	}
	complete = true
	return nil
}

func (storage *Local) Get(ctx context.Context, key string) (Object, error) {
	if err := ValidateKey(key); err != nil {
		return Object{}, err
	}
	if err := ctx.Err(); err != nil {
		return Object{}, err
	}
	root, err := os.OpenRoot(storage.root)
	if err != nil {
		return Object{}, fmt.Errorf("local object storageを開けません: %w", err)
	}
	defer root.Close()
	file, err := root.Open(key)
	if errors.Is(err, fs.ErrNotExist) {
		return Object{}, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return Object{}, fmt.Errorf("objectを開けません: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return Object{}, fmt.Errorf("object metadataを取得できません: %w", err)
	}
	if !info.Mode().IsRegular() {
		_ = file.Close()
		return Object{}, fmt.Errorf("%w: regular fileではありません", ErrInvalidKey)
	}
	return Object{
		Key: key, Size: info.Size(), Body: &contextReadCloser{ctx: ctx, value: file}, LastModified: info.ModTime(),
	}, nil
}

func (storage *Local) Delete(ctx context.Context, key string) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := os.OpenRoot(storage.root)
	if err != nil {
		return fmt.Errorf("local object storageを開けません: %w", err)
	}
	defer root.Close()
	if err := root.Remove(key); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("objectを削除できません: %w", err)
	}
	return nil
}

func (storage *Local) List(ctx context.Context, prefix string) ([]Ref, error) {
	if err := ValidatePrefix(prefix); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(storage.root)
	if err != nil {
		return nil, fmt.Errorf("local object storageを開けません: %w", err)
	}
	defer root.Close()
	start := strings.TrimSuffix(prefix, "/")
	if start == "" {
		start = "."
	}
	refs := make([]Ref, 0)
	err = fs.WalkDir(root.FS(), start, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, fs.ErrNotExist) && name == start {
				return fs.SkipDir
			}
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		refs = append(refs, Ref{Key: strings.TrimPrefix(name, "./"), LastModified: info.ModTime()})
		return nil
	})
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("objectsを一覧できません: %w", err)
	}
	slices.SortFunc(refs, func(left, right Ref) int { return strings.Compare(left.Key, right.Key) })
	return refs, nil
}

func (storage *S3) Put(ctx context.Context, key string, contentType string, data []byte) error {
	return storage.PutReader(ctx, key, contentType, bytes.NewReader(data), int64(len(data)))
}

func (storage *S3) PutReader(
	ctx context.Context, key string, contentType string, reader io.Reader, size int64,
) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	if reader == nil || size < 0 {
		return errors.New("object readerまたはsizeが不正です")
	}
	_, err := storage.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(storage.bucket), Key: aws.String(key), ContentType: aws.String(contentType),
		ContentLength: aws.Int64(size), Body: reader, IfNoneMatch: aws.String("*"),
	})
	if isS3Status(err, http.StatusPreconditionFailed, http.StatusConflict) {
		return fmt.Errorf("%w: %s", ErrAlreadyExists, key)
	}
	if err != nil {
		return fmt.Errorf("S3 objectを書き込めません: %w", err)
	}
	return nil
}

type contextReader struct {
	ctx   context.Context
	value io.Reader
}

func (reader *contextReader) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.value.Read(buffer)
}

func (storage *S3) Get(ctx context.Context, key string) (Object, error) {
	if err := ValidateKey(key); err != nil {
		return Object{}, err
	}
	response, err := storage.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(storage.bucket), Key: aws.String(key),
	})
	var noSuchKey *types.NoSuchKey
	var notFound *types.NotFound
	if errors.As(err, &noSuchKey) || errors.As(err, &notFound) || isS3Status(err, http.StatusNotFound) {
		return Object{}, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return Object{}, fmt.Errorf("S3 objectを読み取れません: %w", err)
	}
	var contentType string
	if response.ContentType != nil {
		contentType = *response.ContentType
	}
	var lastModified time.Time
	if response.LastModified != nil {
		lastModified = *response.LastModified
	}
	size := int64(-1)
	if response.ContentLength != nil {
		size = *response.ContentLength
	}
	return Object{
		Key: key, ContentType: contentType, Size: size,
		Body: &contextReadCloser{ctx: ctx, value: response.Body}, LastModified: lastModified,
	}, nil
}

func (storage *S3) Delete(ctx context.Context, key string) error {
	if err := ValidateKey(key); err != nil {
		return err
	}
	_, err := storage.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(storage.bucket), Key: aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("S3 objectを削除できません: %w", err)
	}
	return nil
}

func (storage *S3) List(ctx context.Context, prefix string) ([]Ref, error) {
	if err := ValidatePrefix(prefix); err != nil {
		return nil, err
	}
	result := make([]Ref, 0)
	paginator := s3.NewListObjectsV2Paginator(storage.client, &s3.ListObjectsV2Input{
		Bucket: aws.String(storage.bucket), Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("S3 objectsを一覧できません: %w", err)
		}
		for _, item := range page.Contents {
			if item.Key == nil || item.LastModified == nil {
				continue
			}
			result = append(result, Ref{Key: *item.Key, LastModified: *item.LastModified})
		}
	}
	slices.SortFunc(result, func(left, right Ref) int { return strings.Compare(left.Key, right.Key) })
	return result, nil
}

func isS3Status(err error, statuses ...int) bool {
	if err == nil {
		return false
	}
	var responseErr *awshttp.ResponseError
	if !errors.As(err, &responseErr) || responseErr.ResponseError == nil {
		return false
	}
	return slices.Contains(statuses, responseErr.ResponseError.HTTPStatusCode())
}

type contextReadCloser struct {
	ctx   context.Context
	value io.ReadCloser
}

func (reader *contextReadCloser) Read(buffer []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.value.Read(buffer)
}

func (reader *contextReadCloser) Close() error {
	return reader.value.Close()
}

var _ Store = (*Local)(nil)
var _ Store = (*S3)(nil)
