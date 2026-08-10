package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/admin"
	"github.com/geibee/gis-example/apps/feedback-service-go/internal/auth"
)

func TestDecodeMembershipCreateAndPatch(t *testing.T) {
	t.Parallel()
	create, err := decodeMembershipCreate([]byte(`{
      "issuer":"https://id.example.test", "subject":"subject-1",
      "permissions":["feedback.read","feedback.admin"]
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if create.Issuer != "https://id.example.test" || create.Subject != "subject-1" ||
		len(create.Permissions) != 2 || create.Permissions[1] != auth.PermissionAdmin {
		t.Fatalf("membership create = %+v", create)
	}
	patch, err := decodeMembershipPatch([]byte(`{"permissions":["feedback.manage"]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(patch.Permissions) != 1 || patch.Permissions[0] != auth.PermissionManage {
		t.Fatalf("membership patch = %+v", patch)
	}
}

func TestMembershipDecodersRejectInvalidJSONShape(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`null`, `[]`, `{"issuer":"issuer","subject":"subject","permissions":[],"unknown":true}`, `{} {}`,
	} {
		if _, err := decodeMembershipCreate([]byte(body)); err == nil {
			t.Fatalf("不正create bodyを受理しました: %s", body)
		}
	}
	for _, body := range []string{`null`, `[]`, `{}`, `{"permissions":null}`, `{"permissions":[],"unknown":true}`, `{} {}`} {
		if _, err := decodeMembershipPatch([]byte(body)); err == nil {
			t.Fatalf("不正patch bodyを受理しました: %s", body)
		}
	}
}

func TestMapAdminError(t *testing.T) {
	t.Parallel()
	tests := []struct {
		kind   error
		status int
	}{
		{admin.ErrInvalidInput, http.StatusBadRequest},
		{admin.ErrNotFound, http.StatusNotFound},
		{admin.ErrConflict, http.StatusConflict},
		{admin.ErrVersionMismatch, http.StatusPreconditionFailed},
	}
	for _, test := range tests {
		mapped, ok := mapAdminError(&admin.Error{
			Kind: test.kind, Code: "membership.test", Detail: "detail",
		}).(*APIError)
		if !ok || mapped.Status != test.status || mapped.Problem.Code != "membership.test" {
			t.Fatalf("mapAdminError(%v) = %#v", test.kind, mapped)
		}
	}
	unknown := errors.New("unknown")
	if mapAdminError(unknown) != unknown {
		t.Fatal("未知errorは変更せず返す必要があります")
	}
}

func TestMembershipMemberEncodesNullableFields(t *testing.T) {
	t.Parallel()
	encoded, err := json.Marshal(admin.Member{
		UserID: "00000000-0000-0000-0000-000000000001", Issuer: "issuer", Subject: "subject",
		Permissions: []auth.Permission{auth.PermissionRead}, Version: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"email", "displayName"} {
		value, exists := object[name]
		if !exists || string(value) != "null" {
			t.Fatalf("%s nullable field = %s (exists=%v)", name, value, exists)
		}
	}
}
