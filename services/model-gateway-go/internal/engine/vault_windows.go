//go:build windows

package engine

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var advapi32 = syscall.NewLazyDLL("advapi32.dll")

type blob struct {
	Size uint32
	Data *byte
}

func protect(input []byte, decrypt bool) ([]byte, error) {
	if len(input) == 0 || len(input) > 65536 {
		return nil, errors.New("invalid protected value")
	}
	in := blob{uint32(len(input)), &input[0]}
	var out blob
	var ok uintptr
	if decrypt {
		ok, _, _ = crypt32.NewProc("CryptUnprotectData").Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&out)))
	} else {
		ok, _, _ = crypt32.NewProc("CryptProtectData").Call(uintptr(unsafe.Pointer(&in)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&out)))
	}
	runtime.KeepAlive(input)
	if ok == 0 {
		return nil, errors.New("DPAPI operation failed")
	}
	defer kernel32.NewProc("LocalFree").Call(uintptr(unsafe.Pointer(out.Data)))
	return bytes.Clone(unsafe.Slice(out.Data, int(out.Size))), nil
}
func privateACL(path string) error {
	u, err := user.Current()
	if err != nil || !strings.HasPrefix(u.Uid, "S-1-") {
		return errors.New("current Windows identity unavailable")
	}
	sddl, _ := syscall.UTF16PtrFromString("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + u.Uid + ")")
	var sd uintptr
	ok, _, _ := advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW").Call(uintptr(unsafe.Pointer(sddl)), 1, uintptr(unsafe.Pointer(&sd)), 0)
	if ok == 0 {
		return errors.New("private ACL creation failed")
	}
	defer kernel32.NewProc("LocalFree").Call(sd)
	var present, defaulted int32
	var acl uintptr
	ok, _, _ = advapi32.NewProc("GetSecurityDescriptorDacl").Call(sd, uintptr(unsafe.Pointer(&present)), uintptr(unsafe.Pointer(&acl)), uintptr(unsafe.Pointer(&defaulted)))
	if ok == 0 || present == 0 {
		return errors.New("private ACL unavailable")
	}
	name, _ := syscall.UTF16PtrFromString(path)
	code, _, _ := advapi32.NewProc("SetNamedSecurityInfoW").Call(uintptr(unsafe.Pointer(name)), 1, 0x80000004, 0, 0, acl, 0)
	if code != 0 {
		return errors.New("private ACL application failed")
	}
	return nil
}
func EnsureDir(dir string) error {
	if !filepath.IsAbs(dir) || filepath.Clean(dir) == filepath.VolumeName(dir)+string(os.PathSeparator) {
		return errors.New("absolute private data directory required")
	}
	if info, err := os.Lstat(dir); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("reparse data directory forbidden")
	}
	if _, err := os.Stat(filepath.Join(dir, ".daming-owned")); err != nil {
		entries, err := os.ReadDir(dir)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if len(entries) != 0 {
			return errors.New("refusing foreign nonempty data directory")
		}
		if err = os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if err = privateACL(dir); err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(dir, ".daming-owned"), []byte("Daming gateway v1\n"), 0600)
	}
	return privateACL(dir)
}
func SaveKey(dir, key string) error {
	if len(key) < 8 || len(key) > 4096 || strings.IndexFunc(key, func(r rune) bool { return r < 33 || r > 126 }) >= 0 {
		return errors.New("invalid API key")
	}
	if err := EnsureDir(dir); err != nil {
		return err
	}
	// MSIX filesystem redirection can make two lexical C: paths resolve to
	// different volumes during rename. Resolve the already-owned directory
	// through its handle before creating and replacing the encrypted file.
	physical, err := physicalDirectory(dir)
	if err != nil {
		return err
	}
	dir = physical
	b, err := protect([]byte(key), false)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".credential-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	f.Close()
	return os.Rename(tmp, filepath.Join(dir, "deepseek.dpapi"))
}
func physicalDirectory(dir string) (string, error) {
	name, err := syscall.UTF16PtrFromString(dir)
	if err != nil {
		return "", err
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", errors.New("owned directory handle unavailable")
	}
	defer syscall.CloseHandle(h)
	buffer := make([]uint16, 32768)
	n, _, _ := kernel32.NewProc("GetFinalPathNameByHandleW").Call(uintptr(h), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
	if n == 0 || n >= uintptr(len(buffer)) {
		return "", errors.New("owned directory physical path unavailable")
	}
	return syscall.UTF16ToString(buffer[:n]), nil
}
func LoadKey(dir string) (string, error) {
	f, err := os.Open(filepath.Join(dir, "deepseek.dpapi"))
	if err != nil {
		return "", errors.New("provider not configured")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() > 65536 {
		return "", errors.New("invalid credential")
	}
	b := make([]byte, info.Size())
	if _, err = io.ReadFull(f, b); err != nil {
		return "", errors.New("credential read failed")
	}
	plain, err := protect(b, true)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

type Lock struct{ handle syscall.Handle }

func AcquireLock(path string) (*Lock, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, errors.New("already running or locked")
	}
	return &Lock{h}, nil
}
func (l *Lock) Close() error { return syscall.CloseHandle(l.handle) }
func MaskedKey() (string, error) {
	handle := os.Stdin.Fd()
	var mode uint32
	ok, _, _ := kernel32.NewProc("GetConsoleMode").Call(handle, uintptr(unsafe.Pointer(&mode)))
	if ok == 0 {
		return "", errors.New("open a local terminal for masked key entry")
	}
	ok, _, _ = kernel32.NewProc("SetConsoleMode").Call(handle, uintptr(mode&^4))
	if ok == 0 {
		return "", errors.New("cannot disable console echo")
	}
	defer kernel32.NewProc("SetConsoleMode").Call(handle, uintptr(mode))
	fmt.Fprint(os.Stderr, "DeepSeek API key (hidden): ")
	key, err := bufio.NewReader(os.Stdin).ReadString('\n')
	fmt.Fprintln(os.Stderr)
	return strings.TrimSpace(key), err
}

type credUI struct {
	Size    uint32
	Parent  uintptr
	Message *uint16
	Caption *uint16
	Banner  uintptr
}

func DialogKey() (string, error) {
	message, _ := syscall.UTF16PtrFromString("Enter your DeepSeek API key in Password. It is encrypted for this Windows user; no model request is made.")
	caption, _ := syscall.UTF16PtrFromString("Daming - DeepSeek API key")
	target, _ := syscall.UTF16PtrFromString("Daming DeepSeek")
	info := credUI{Message: message, Caption: caption}
	info.Size = uint32(unsafe.Sizeof(info))
	username := make([]uint16, 256)
	copy(username, syscall.StringToUTF16("DeepSeek"))
	password := make([]uint16, 4096)
	var save int32
	code, _, _ := syscall.NewLazyDLL("credui.dll").NewProc("CredUIPromptForCredentialsW").Call(uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(target)), 0, 0, uintptr(unsafe.Pointer(&username[0])), uintptr(len(username)), uintptr(unsafe.Pointer(&password[0])), uintptr(len(password)), uintptr(unsafe.Pointer(&save)), 0x4008a)
	if code != 0 {
		return "", errors.New("key entry cancelled or unavailable")
	}
	key := syscall.UTF16ToString(password)
	for i := range password {
		password[i] = 0
	}
	return key, nil
}
