package replay

import (
	"fmt"
	"os"
	"path/filepath"
)

// WriteFileAtomic writes data to path via a temp file in the same directory
// and a rename, so readers never see a partial file and a failed write leaves
// any existing file untouched.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) (err error) {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("replay: create temp file: %w", err)
	}
	tmp := f.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(tmp)
		}
	}()
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return fmt.Errorf("replay: write temp file: %w", err)
	}
	if err = f.Chmod(perm); err != nil {
		_ = f.Close()
		return fmt.Errorf("replay: chmod temp file: %w", err)
	}
	if err = f.Close(); err != nil {
		return fmt.Errorf("replay: close temp file: %w", err)
	}
	if err = os.Rename(tmp, path); err != nil {
		return fmt.Errorf("replay: replace %s: %w", path, err)
	}
	return nil
}
