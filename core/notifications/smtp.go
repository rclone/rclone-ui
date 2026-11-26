package notifications

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	netmail "net/mail"
	"net/textproto"
	"strings"
	"time"

	"github.com/wneessen/go-mail"

	"github.com/rclone/rclone-ui/core/db"
	"github.com/rclone/rclone-ui/core/errs"
	"github.com/rclone/rclone-ui/core/i18n"
)

var errNotSetUp = errs.New("SMTP is not set up. Save the mail server in the Notifications window first.")

const smtpTimeout = 15 * time.Second

const smtpAccount = "smtp"

type SMTP struct {
	Host        string
	Port        int
	Encryption  string
	Username    string
	Password    string
	FromAddress string
	FromName    string
}

func view(c SMTP) SMTPView {
	return SMTPView{
		Host:        c.Host,
		Port:        c.Port,
		Encryption:  SMTPEncryption(c.Encryption),
		Username:    c.Username,
		HasPassword: c.Password != "",
		FromAddress: c.FromAddress,
		FromName:    c.FromName,
	}
}

func (s *Service) savedSMTP(ctx context.Context) (*SMTP, error) {
	var c SMTP
	err := s.db.Read(ctx, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `SELECT host, port, encryption, username, from_address, from_name
			FROM notification_smtp WHERE id = 1`).Scan(&c.Host, &c.Port, &c.Encryption, &c.Username, &c.FromAddress, &c.FromName)
	})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if c.Username != "" {
		c.Password, _ = s.secrets.Get(smtpAccount)
	}
	return &c, nil
}

func (s *Service) SMTP(ctx context.Context) (SMTPView, error) {
	c, err := s.savedSMTP(ctx)
	if err != nil || c == nil {
		return SMTPView{}, err
	}
	return view(*c), nil
}

func (s *Service) SetSMTP(ctx context.Context, in SMTPInput) (SMTPView, error) {
	host := strings.TrimSpace(in.Host)
	if host == "" {
		err := s.db.Write(ctx, func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `DELETE FROM notification_smtp`)
			return err
		})
		if err != nil {
			return SMTPView{}, err
		}
		_ = s.secrets.Delete(smtpAccount)
		s.changed()
		return SMTPView{}, nil
	}
	if err := firstProblem(in.problems(), "port", "encryption", "fromAddress"); err != nil {
		return SMTPView{}, err
	}
	c := SMTP{
		Host:        host,
		Port:        in.Port,
		Encryption:  string(in.Encryption),
		Username:    strings.TrimSpace(in.Username),
		FromAddress: strings.TrimSpace(in.FromAddress),
		FromName:    strings.TrimSpace(in.FromName),
	}
	if c.Username != "" {
		c.Password = in.Password
		if c.Password == "" {
			saved, err := s.savedSMTP(ctx)
			if err != nil {
				return SMTPView{}, err
			}
			if saved != nil {
				c.Password = saved.Password
			}
		}
	}
	restore := func() {}
	if c.Password != "" {
		old, oldErr := s.secrets.Get(smtpAccount)
		if err := s.secrets.Set(smtpAccount, c.Password); err != nil {
			return SMTPView{}, fmt.Errorf("saving the mail server's password: %w", err)
		}
		if oldErr == nil && old != c.Password {
			restore = func() { _ = s.secrets.Set(smtpAccount, old) }
		}
	}
	err := s.db.Write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO notification_smtp
			(id, host, port, encryption, username, from_address, from_name, updated_ms)
			VALUES (1, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET host = excluded.host, port = excluded.port,
				encryption = excluded.encryption, username = excluded.username,
				from_address = excluded.from_address, from_name = excluded.from_name,
				updated_ms = excluded.updated_ms`,
			c.Host, c.Port, c.Encryption, c.Username, c.FromAddress, c.FromName, db.NowMS())
		return err
	})
	if err != nil {
		restore()
		return SMTPView{}, err
	}
	if c.Password == "" && c.Username == "" {
		_ = s.secrets.Delete(smtpAccount)
	}
	s.changed()
	return view(c), nil
}

func (s *Service) TestSMTP(ctx context.Context, to string) (Outcome, error) {
	c, err := s.savedSMTP(ctx)
	if err != nil {
		return Outcome{}, err
	}
	if c == nil {
		return outcome(errNotSetUp, ""), nil
	}
	title, body := testMessage("")
	err = s.mail(ctx, *c, recipients(to), title, body)
	// i18n: The value is the address that the test email went to.
	return outcome(err, i18n.T("A test email went to %s.", strings.TrimSpace(to))), nil
}

func (s *Service) mailText(body string) string {
	return fmt.Sprintf("%s\n\n— Rclone UI v%s", body, s.version)
}

func (s *Service) mail(ctx context.Context, c SMTP, to []string, subject, text string) error {
	if err := checkRecipients(to); err != nil {
		return err
	}
	from, err := mailbox(c.FromAddress)
	if err != nil {
		return err
	}
	client, err := mail.NewClient(c.Host, s.smtpOptions(c)...)
	if err != nil {
		return fmt.Errorf("the mail server's settings: %w", err)
	}
	for attempt := 1; ; attempt++ {
		msg := mail.NewMsg()
		msg.SetAddrHeaderFromMailAddress(mail.HeaderFrom, &netmail.Address{Name: c.FromName, Address: from})
		if err := msg.To(to...); err != nil {
			return err
		}
		msg.Subject(subject)
		msg.SetDate()
		msg.SetMessageID()
		msg.SetBodyString(mail.TypeTextPlain, s.mailText(text))
		err = client.DialAndSendWithContext(ctx, msg)
		if err == nil || attempt == 2 || permanent(err) || sleep(ctx, s.retryDelay) != nil {
			return err
		}
	}
}

func (s *Service) smtpOptions(c SMTP) []mail.Option {
	opts := []mail.Option{
		mail.WithPort(c.Port),
		mail.WithTimeout(smtpTimeout),
		mail.WithTLSConfig(&tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12, RootCAs: s.tlsRoots}),
	}
	plain, login := mail.SMTPAuthPlain, mail.SMTPAuthLogin
	switch SMTPEncryption(c.Encryption) {
	case SMTPEncryptionTLS:
		opts = append(opts, mail.WithSSL(), mail.WithTLSPolicy(mail.NoTLS))
	case SMTPEncryptionNone:
		opts = append(opts, mail.WithTLSPolicy(mail.NoTLS))
		plain, login = mail.SMTPAuthPlainNoEnc, mail.SMTPAuthLoginNoEnc
	default:
		opts = append(opts, mail.WithTLSPolicy(mail.TLSMandatory))
	}
	if c.Username != "" {
		opts = append(opts, mail.WithUsername(c.Username), mail.WithPassword(c.Password),
			mail.WithOpportunisticSMTPAuth(plain, login))
	}
	return opts
}

func permanent(err error) bool {
	var se *mail.SendError
	if errors.As(err, &se) {
		return se.ErrorCode() >= 500
	}
	var te *textproto.Error
	return errors.As(err, &te) && te.Code >= 500
}
