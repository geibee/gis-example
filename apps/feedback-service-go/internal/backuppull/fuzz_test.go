package backuppull

import (
	"path/filepath"
	"testing"
)

func FuzzResolveTarget(f *testing.F) {
	for _, seed := range []string{"backup.zip", "../outside.zip", "sub/outside.zip", "..", "", "backup\\outside.zip"} {
		f.Add(seed)
	}
	destination := filepath.Join(string(filepath.Separator), "var", "lib", "feedback-backups")
	f.Fuzz(func(t *testing.T, name string) {
		target, err := ResolveTarget(destination, name)
		if err == nil && (filepath.Dir(target) != destination || filepath.Base(target) != name) {
			t.Fatalf("destination外のpathを生成しました: name=%q target=%q", name, target)
		}
	})
}
