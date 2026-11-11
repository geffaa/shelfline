package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestPairSaveLoad(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct{ PairingCode string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		if r.URL.Path != "/devices/pair" || in.PairingCode != "ABCD-EFGH" {
			http.Error(w, `{"code":"invalid_pairing_code"}`, 400)
			return
		}
		_, _ = w.Write([]byte(`{"bridgeId":"b1","secret":"abc","location":"Fitzroy","timezone":"Australia/Melbourne"}`))
	}))
	defer srv.Close()
	if _, err := Pair(srv.URL, "NOPE", nil); err == nil {
		t.Fatal("a wrong code must be refused")
	}
	c, err := Pair(srv.URL, "ABCD-EFGH", nil)
	if err != nil || c.BridgeID != "b1" || c.Secret != "abc" || c.Timezone != "Australia/Melbourne" {
		t.Fatalf("%+v %v", c, err)
	}
	dir := t.TempDir()
	if err := c.Save(dir); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(filepath.Join(dir, "config.json")); st.Mode().Perm() != 0o600 {
		t.Fatalf("the signing key must be owner-only, got %v", st.Mode())
	}
	back, err := Load(dir)
	if err != nil || *back != *c {
		t.Fatalf("%+v %v", back, err)
	}
	if _, err := Load(t.TempDir()); err == nil {
		t.Fatal("no config means not paired")
	}
}
