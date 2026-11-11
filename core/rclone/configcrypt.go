package rclone

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"github.com/rclone/rclone/fs/config/obscure"
	"golang.org/x/crypto/nacl/secretbox"

	"github.com/rclone/rclone-ui/core/children/childenv"
)

// EncryptConfig encrypts a config file's text with password, exactly as rclone writes it
// (fs/config/crypt.go Encrypt), but without using rclone's process-wide key. This lets the app
// encrypt a file that isn't the active one, or change its password.
func EncryptConfig(plain []byte, password string) ([]byte, error) {
	key, err := configKey(password)
	if err != nil {
		return nil, err
	}
	var nonce [24]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, fmt.Errorf("nonce: %w", err)
	}
	var out bytes.Buffer
	out.WriteString("# Encrypted rclone configuration File\n\n" + encryptHeader + "\n")
	enc := base64.NewEncoder(base64.StdEncoding, &out)
	_, _ = enc.Write(nonce[:])
	_, _ = enc.Write(secretbox.Seal(nil, plain, &nonce, &key))
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// DecryptConfig decrypts a config file's text with password. It returns ErrWrongPassword when
// the password doesn't open it, and returns a file that isn't encrypted unchanged.
func DecryptConfig(data []byte, password string) ([]byte, error) {
	plain, err := decrypt(data, password)
	if errors.Is(err, ErrNotEncrypted) {
		return data, nil
	}
	return plain, err
}

// decrypt decrypts a config file's text as rclone's Decrypt does (crypt.go:128-172), with the
// key that rclone's SetConfigPassword derives (configKey). It returns ErrNotEncrypted for a file
// without rclone's header, and ErrWrongPassword for a password that doesn't open it.
func decrypt(data []byte, password string) ([]byte, error) {
	r, err := afterHeader(bufio.NewReader(bytes.NewReader(data)))
	if err != nil {
		return nil, err
	}
	box, err := io.ReadAll(base64.NewDecoder(base64.StdEncoding, r))
	if err != nil {
		return nil, fmt.Errorf("failed to load base64 encoded data: %w", err)
	}
	if len(box) < 24+secretbox.Overhead {
		return nil, errors.New("configuration data too short")
	}
	key, err := configKey(password)
	if err != nil {
		return nil, err
	}
	var nonce [24]byte
	copy(nonce[:], box[:24])
	plain, ok := secretbox.Open(nil, box[24:], &nonce, &key)
	if !ok {
		return nil, ErrWrongPassword
	}
	return plain, nil
}

// ChildKeyFile writes the key for password to a new 0600 file in dir, which a child rclone uses
// to open an encrypted config. The file's path goes in the child's childenv.KeyFileEnv, and
// rclone reads and then deletes the file (fs/config/crypt.go:133-148). The password itself never
// appears in the child's arguments or environment.
func ChildKeyFile(dir, password string) (string, error) {
	key, err := configKey(password)
	if err != nil {
		return "", err
	}
	return childenv.WriteKeyFile(dir, []byte(obscure.MustObscure(string(key[:]))))
}
