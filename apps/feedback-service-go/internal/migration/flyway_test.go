package migration

import "testing"

func TestFlywayChecksumIgnoresLineEndings(t *testing.T) {
	t.Parallel()
	withFinalLF, err := FlywayChecksum([]byte("SELECT 1;\nSELECT 2;\n"))
	if err != nil {
		t.Fatal(err)
	}
	withoutFinalLF, err := FlywayChecksum([]byte("SELECT 1;\nSELECT 2;"))
	if err != nil {
		t.Fatal(err)
	}
	if withFinalLF != withoutFinalLF {
		t.Fatalf("末尾LFでchecksumが変化しました: %d != %d", withFinalLF, withoutFinalLF)
	}
}
