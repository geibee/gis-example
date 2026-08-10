package httpapi

import (
	"testing"
)

func TestDecodeNotificationSettingsDefaultsAndNull(t *testing.T) {
	t.Parallel()
	settings, err := decodeNotificationSettings([]byte(`{"webhookEnabled":false,"webhookEndpoint":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.WebhookEnabled || settings.WebhookEndpoint != nil || settings.IncludeBody || settings.IncludeEvidence {
		t.Fatalf("notification settings = %+v", settings)
	}
	endpoint := "https://hooks.example.test/feedback"
	settings, err = decodeNotificationSettings([]byte(`{
      "webhookEnabled":true,"webhookEndpoint":"https://hooks.example.test/feedback",
      "includeBody":true,"includeEvidence":false
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if settings.WebhookEndpoint == nil || *settings.WebhookEndpoint != endpoint || !settings.IncludeBody {
		t.Fatalf("notification settings = %+v", settings)
	}
}

func TestDecodeNotificationConnectorDefaults(t *testing.T) {
	t.Parallel()
	create, err := decodeNotificationConnectorCreate([]byte(`{
      "connectorType":"slack","name":"review","destinationRef":"reviews"
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if !create.Enabled || create.IncludeBody || create.ConnectorType != "slack" {
		t.Fatalf("connector create = %+v", create)
	}
	patch, err := decodeNotificationConnectorPatch([]byte(`{
      "name":"review","destinationRef":"reviews","enabled":false
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if patch.Enabled || patch.IncludeBody || patch.Name != "review" {
		t.Fatalf("connector patch = %+v", patch)
	}
}

func TestNotificationDecodersRejectInvalidShape(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`null`, `[]`, `{}`, `{"webhookEnabled":null}`,
		`{"webhookEnabled":false,"includeBody":null}`,
		`{"webhookEnabled":false,"unknown":true}`, `{"webhookEnabled":false} {}`,
	} {
		if _, err := decodeNotificationSettings([]byte(body)); err == nil {
			t.Fatalf("不正settings bodyを受理しました: %s", body)
		}
	}
	for _, body := range []string{
		`null`, `[]`, `{}`, `{"connectorType":"slack","name":"n","destinationRef":"d","enabled":null}`,
		`{"connectorType":"slack","name":"n","destinationRef":"d","unknown":true}`,
	} {
		if _, err := decodeNotificationConnectorCreate([]byte(body)); err == nil {
			t.Fatalf("不正connector create bodyを受理しました: %s", body)
		}
	}
	for _, body := range []string{
		`null`, `[]`, `{}`, `{"name":"n","destinationRef":"d"}`,
		`{"name":"n","destinationRef":"d","enabled":null}`,
		`{"name":"n","destinationRef":"d","enabled":true,"unknown":true}`,
	} {
		if _, err := decodeNotificationConnectorPatch([]byte(body)); err == nil {
			t.Fatalf("不正connector patch bodyを受理しました: %s", body)
		}
	}
}
