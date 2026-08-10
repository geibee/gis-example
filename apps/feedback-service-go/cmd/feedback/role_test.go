package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseLegacyInvocation(t *testing.T) {
	t.Parallel()
	invocation, err := parseLegacyInvocation([]string{
		"apply", "--input", "snapshot.json", "--run-id", "00000000-0000-0000-0000-000000000001", "--confirm-copy",
	})
	if err != nil {
		t.Fatal(err)
	}
	if invocation.command != "apply" || invocation.input != "snapshot.json" || !invocation.confirmCopy {
		t.Fatalf("legacy invocation = %+v", invocation)
	}
	for _, arguments := range [][]string{
		{}, {"unknown", "--input", "snapshot.json"}, {"apply", "--input", "snapshot.json"},
		{"rollback", "--input", "snapshot.json", "--run-id", "id"},
		{"reconcile", "--input", "snapshot.json"}, {"dry-run", "--unknown"},
	} {
		if _, err := parseLegacyInvocation(arguments); err == nil {
			t.Fatalf("不正legacy invocationを受理しました: %v", arguments)
		}
	}
}

func TestConnectorRoleHelpers(t *testing.T) {
	t.Parallel()
	health, err := resolveConnectorHealthURL(
		"https://connector.example.test/connector/v1/manifest", "/health/ready",
	)
	if err != nil || health != "https://connector.example.test/health/ready" {
		t.Fatalf("health URL=%q err=%v", health, err)
	}
	var values map[string]string
	if err := decodeStringMap(`{"review":"https://hooks.example.test/review"}`, &values); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(values, map[string]string{"review": "https://hooks.example.test/review"}) {
		t.Fatalf("destinations=%v", values)
	}
	for _, raw := range []string{`null`, `[]`, `{"review":1}`, `{} {}`, `{"review":"x"} trailing`} {
		values = nil
		if err := decodeStringMap(raw, &values); err == nil {
			t.Fatalf("不正string mapを受理しました: %s", raw)
		}
	}
}

func TestIntegerEnvironmentErrorDoesNotContainSecret(t *testing.T) {
	t.Setenv("FEEDBACK_CONNECTOR_PORT", "not-a-port")
	_, err := integerEnvironment("FEEDBACK_CONNECTOR_PORT", 8091, 1, 65_535)
	if err == nil || !strings.Contains(err.Error(), "FEEDBACK_CONNECTOR_PORT") {
		t.Fatalf("port error=%v", err)
	}
}
