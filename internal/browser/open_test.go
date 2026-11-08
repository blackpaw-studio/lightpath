package browser

import (
	"errors"
	"reflect"
	"testing"
)

type call struct {
	name string
	args []string
}

func TestOpenUsesArgvWithoutShell(t *testing.T) {
	url := "http://127.0.0.1:47800/"
	for goos, want := range map[string]call{
		"darwin": {"open", []string{url}},
		"linux":  {"xdg-open", []string{url}},
	} {
		var got call
		err := open(goos, url, func(name string, args ...string) error {
			got = call{name, args}
			return nil
		})
		if err != nil {
			t.Fatalf("%s: %v", goos, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %+v want %+v", goos, got, want)
		}
	}
}

func TestOpenRejectsUnsupportedOSAndUnsafeURLs(t *testing.T) {
	never := func(string, ...string) error { t.Fatal("must not start a process"); return nil }
	if err := open("windows", "http://127.0.0.1:1/", never); err == nil {
		t.Error("windows should be unsupported")
	}
	for _, u := range []string{
		"", "-a Calculator", "--help", "file:///etc/passwd", "javascript:alert(1)",
		"http://", "127.0.0.1:47800", "http://127.0.0.1:1/\n--evil", "http://a b/",
	} {
		if err := open("linux", u, never); err == nil {
			t.Errorf("url %q should be rejected", u)
		}
	}
}

func TestOpenPropagatesRunnerError(t *testing.T) {
	boom := errors.New("xdg-open not found")
	err := open("linux", "http://localhost:1/", func(string, ...string) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("got %v", err)
	}
}
