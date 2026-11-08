package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
)

// Valid reports whether g is a known geo source.
func (g GeoSource) Valid() bool {
	switch g {
	case GeoAPI, GeoHostname, GeoLocal, GeoEstimated:
		return true
	}
	return false
}

// Valid reports whether c is a known error code.
func (c ErrorCode) Valid() bool {
	switch c {
	case ErrInvalidTarget, ErrBadMessage, ErrTracerouteMissing, ErrTracerouteFailed, ErrBusyReplay, ErrBusy:
		return true
	}
	return false
}

func (m Hop) validate() error {
	if !m.GeoSource.Valid() {
		return fmt.Errorf("protocol: hop geoSource %q", m.GeoSource)
	}
	return nil
}

func (m Error) validate() error {
	if !m.Code.Valid() {
		return fmt.Errorf("protocol: error code %q", m.Code)
	}
	return nil
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func jsonName(f reflect.StructField) string {
	name, _, _ := strings.Cut(f.Tag.Get("json"), ",")
	if name == "" {
		return f.Name
	}
	return name
}

// requireFields checks that raw has every JSON field of t, recursively, and
// that only pointer fields are null: the UI's shape() checks require every
// key to be present and only nullable fields to hold null.
func requireFields(raw json.RawMessage, t reflect.Type, path string) error {
	switch t.Kind() {
	case reflect.Struct:
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
			return fmt.Errorf("protocol: %s must be an object", path)
		}
		for i := range t.NumField() {
			f := t.Field(i)
			name := jsonName(f)
			v, ok := obj[name]
			if !ok {
				return fmt.Errorf("protocol: %s.%s is missing", path, name)
			}
			if err := requireValue(v, f.Type, path+"."+name); err != nil {
				return err
			}
		}
	case reflect.Slice:
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil || items == nil {
			return fmt.Errorf("protocol: %s must be an array", path)
		}
		for i, item := range items {
			if err := requireValue(item, t.Elem(), fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
	}
	return nil
}

func requireValue(raw json.RawMessage, t reflect.Type, path string) error {
	if isNull(raw) {
		if t.Kind() == reflect.Pointer {
			return nil
		}
		return fmt.Errorf("protocol: %s must not be null", path)
	}
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	return requireFields(raw, t, path)
}

// fieldCheck validates one hop.update value and returns its decoded form.
type fieldCheck func(raw json.RawMessage) (any, error)

func nullableOf[T any](valid func(T) bool) fieldCheck {
	return func(raw json.RawMessage) (any, error) {
		if isNull(raw) {
			return nil, nil
		}
		var v T
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		if valid != nil && !valid(v) {
			return nil, fmt.Errorf("invalid value %s", raw)
		}
		return v, nil
	}
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func geoSourceCheck(raw json.RawMessage) (any, error) {
	var g GeoSource
	if isNull(raw) || json.Unmarshal(raw, &g) != nil || !g.Valid() {
		return nil, fmt.Errorf("invalid geoSource %s", raw)
	}
	return g, nil
}

func annotationsCheck(raw json.RawMessage) (any, error) {
	if err := requireValue(raw, reflect.TypeFor[[]string](), "annotations"); err != nil {
		return nil, err
	}
	var v []string
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	return v, nil
}

// hopUpdateChecks lists every key a hop.update may carry besides type and
// ttl, with the same value rules as the matching Hop field.
var hopUpdateChecks = map[string]fieldCheck{
	"ip":          nullableOf[string](nil),
	"host":        nullableOf[string](nil),
	"asn":         nullableOf[int](nil),
	"org":         nullableOf[string](nil),
	"lat":         nullableOf(finite),
	"lon":         nullableOf(finite),
	"city":        nullableOf[string](nil),
	"geoSource":   geoSourceCheck,
	"annotations": annotationsCheck,
}
