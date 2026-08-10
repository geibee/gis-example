package httpapi

import (
	"testing"

	"github.com/geibee/gis-example/apps/feedback-service-go/internal/session"
)

func TestDecodeSessionCreateDefaultsAndNullableValues(t *testing.T) {
	t.Parallel()
	request, err := decodeSessionCreate([]byte(`{
      "applicationKey":"inventory",
      "environmentKey":"prod",
      "externalWorkspaceKey":"main",
      "manifestVersion":"v1",
      "title":"レビュー",
      "description":null,
      "scopes":[{"pageKey":"home","routeTemplate":null,"reviewable":false}],
      "perspectives":[{"code":"ux","label":"UX","status":"active","guidance":null}]
    }`))
	if err != nil {
		t.Fatal(err)
	}
	if request.OutOfScopePosting != session.OutOfScopeWarn || request.Description != nil {
		t.Fatalf("default/nullが不正です: %+v", request)
	}
	if len(request.Scopes) != 1 || request.Scopes[0].Reviewable || request.Scopes[0].RouteTemplate != nil {
		t.Fatalf("scopeが不正です: %+v", request.Scopes)
	}
	if len(request.Perspectives) != 1 || request.Perspectives[0].Guidance != nil {
		t.Fatalf("perspectiveが不正です: %+v", request.Perspectives)
	}
}

func TestDecodeSessionCreateRejectsUnknownAndNullNonNullableFields(t *testing.T) {
	t.Parallel()
	base := `{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","manifestVersion":"v1","title":"レビュー"}`
	values := []string{
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","manifestVersion":"v1","title":"レビュー","unknown":true}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","manifestVersion":"v1","title":"レビュー","scopes":null}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","manifestVersion":"v1","title":"レビュー","outOfScopePosting":null}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","manifestVersion":"v1","title":"レビュー","scopes":[{"pageKey":"home","reviewable":null}]}`,
		`{"applicationKey":"inventory","environmentKey":"prod","externalWorkspaceKey":"main","manifestVersion":"v1","title":"レビュー","perspectives":[{"code":"ux","label":"UX","status":null}]}`,
		base + `{}`,
	}
	for _, value := range values {
		if _, err := decodeSessionCreate([]byte(value)); err == nil {
			t.Fatalf("不正create bodyを受理しました: %s", value)
		}
	}
}

func TestDecodeSessionPatchDistinguishesAbsentAndNull(t *testing.T) {
	t.Parallel()
	patch, err := decodeSessionPatch([]byte(`{"description":null,"startAt":null,"title":" 更新 "}`), 7)
	if err != nil {
		t.Fatal(err)
	}
	if patch.ExpectedVersion != 7 || !patch.Description.Present || patch.Description.Value != nil {
		t.Fatalf("description nullが不正です: %+v", patch)
	}
	if !patch.StartAt.Present || patch.StartAt.Value != nil || patch.EndAt.Present {
		t.Fatalf("timestampのpresenceが不正です: %+v", patch)
	}
	if patch.Title == nil || *patch.Title != " 更新 " {
		t.Fatalf("titleが不正です: %+v", patch.Title)
	}
}

func TestDecodeSessionPatchRejectsInvalidShape(t *testing.T) {
	t.Parallel()
	for _, value := range []string{`{}`, `{"unknown":true}`, `{"status":null}`, `{"title":1}`, `[]`} {
		_, err := decodeSessionPatch([]byte(value), 1)
		if err == nil {
			t.Fatalf("不正patchを受理しました: %s", value)
		}
	}
}
