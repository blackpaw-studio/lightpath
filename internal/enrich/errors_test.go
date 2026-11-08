package enrich

import (
	"errors"
	"net"
)

func errNXDomain(name string) error {
	return &net.DNSError{Err: "no such host", Name: name, IsNotFound: true}
}

var errTransient = errors.New("servfail")
