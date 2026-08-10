package migration

import "testing"

func TestValidateHandoff(t *testing.T) {
	t.Parallel()
	upgradeFingerprint := HandoffSchemaFingerprint
	freshFingerprint := FreshBaselineSchemaFingerprint
	upgradeMarker := markerWithFingerprint(upgradeFingerprint)
	freshMarker := markerWithFingerprint(freshFingerprint)
	tests := []struct {
		name        string
		history     []FlywayVersion
		marker      BaselineMarker
		fingerprint string
		wantError   bool
	}{
		{
			name:        "V1からV6のupgrade",
			history:     successfulVersions(1, 2, 3, 4, 5, 6),
			marker:      upgradeMarker,
			fingerprint: upgradeFingerprint,
		},
		{
			name:        "収束済みfresh baseline",
			history:     successfulVersions(1),
			marker:      freshMarker,
			fingerprint: freshFingerprint,
		},
		{
			name:        "fresh baselineでupgrade fingerprintを拒否",
			history:     successfulVersions(1),
			marker:      upgradeMarker,
			fingerprint: upgradeFingerprint,
			wantError:   true,
		},
		{
			name:        "upgradeでfresh fingerprintを拒否",
			history:     successfulVersions(1, 2, 3, 4, 5, 6),
			marker:      freshMarker,
			fingerprint: freshFingerprint,
			wantError:   true,
		},
		{
			name:        "途中version欠落",
			history:     successfulVersions(1, 2, 4, 5, 6),
			marker:      upgradeMarker,
			fingerprint: upgradeFingerprint,
			wantError:   true,
		},
		{
			name:        "Flyway失敗",
			history:     []FlywayVersion{{Version: 1, Success: true}, {Version: 2, Success: false}},
			marker:      upgradeMarker,
			fingerprint: upgradeFingerprint,
			wantError:   true,
		},
		{
			name:        "marker fingerprint差分",
			history:     successfulVersions(1, 2, 3, 4, 5, 6),
			marker:      markerWithFingerprint("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"),
			fingerprint: upgradeFingerprint,
			wantError:   true,
		},
		{
			name:        "実schema差分",
			history:     successfulVersions(1, 2, 3, 4, 5, 6),
			marker:      upgradeMarker,
			fingerprint: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
			wantError:   true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateHandoff(test.history, test.marker, test.fingerprint)
			if test.wantError && err == nil {
				t.Fatal("errorになりませんでした")
			}
			if !test.wantError && err != nil {
				t.Fatalf("予期しないerror: %v", err)
			}
		})
	}
}

func successfulVersions(versions ...int64) []FlywayVersion {
	result := make([]FlywayVersion, 0, len(versions))
	for _, version := range versions {
		result = append(result, FlywayVersion{Version: version, Success: true})
	}
	return result
}

func markerWithFingerprint(fingerprint string) BaselineMarker {
	return BaselineMarker{
		Version:                 HandoffVersion,
		Kind:                    "baseline",
		State:                   "succeeded",
		SchemaFingerprintSHA256: &fingerprint,
	}
}
