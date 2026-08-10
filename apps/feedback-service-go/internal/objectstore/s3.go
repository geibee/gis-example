package objectstore

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	serviceconfig "github.com/geibee/gis-example/apps/feedback-service-go/internal/config"
)

type Probe interface {
	CheckReadiness(context.Context) error
	Close() error
}

type S3 struct {
	client *s3.Client
	bucket string
	prefix string
}

func NewS3(ctx context.Context, settings serviceconfig.StorageSettings) (*S3, error) {
	if strings.TrimSpace(settings.Bucket) == "" {
		return nil, errors.New("S3 bucketが未設定です")
	}
	options := []func(*awsconfig.LoadOptions) error{
		// Feedback Serviceの設定契約は環境変数とworkload identityに限定する。
		awsconfig.WithSharedConfigFiles([]string{}),
		awsconfig.WithSharedCredentialsFiles([]string{}),
	}
	if settings.Region != "" {
		options = append(options, awsconfig.WithRegion(settings.Region))
	}
	configuration, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("AWS SDK設定を読み込めません: %w", err)
	}
	client := s3.NewFromConfig(configuration, func(options *s3.Options) {
		if settings.EndpointURL != "" {
			options.BaseEndpoint = aws.String(settings.EndpointURL)
			options.UsePathStyle = true
		}
	})
	return &S3{client: client, bucket: settings.Bucket, prefix: settings.KeyPrefix}, nil
}

func (storage *S3) CheckReadiness(ctx context.Context) error {
	maximum := int32(1)
	_, err := storage.client.ListObjectsV2(ctx, &s3.ListObjectsV2Input{
		Bucket: aws.String(storage.bucket), Prefix: aws.String(storage.prefix), MaxKeys: &maximum,
	})
	if err != nil {
		return fmt.Errorf("S3 object storageを一覧できません: %w", err)
	}
	return nil
}

func (storage *S3) Close() error { return nil }

func NewProbe(ctx context.Context, settings serviceconfig.StorageSettings) (Probe, error) {
	switch settings.Mode {
	case serviceconfig.StorageModeLocal:
		return NewLocal(settings.LocalDirectory)
	case serviceconfig.StorageModeS3:
		return NewS3(ctx, settings)
	default:
		return nil, fmt.Errorf("未対応のobject storage modeです: %s", settings.Mode)
	}
}
