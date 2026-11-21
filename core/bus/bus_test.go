package bus

import (
	"encoding/json"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// drain reads the events buffered for s without waiting, and reports whether C is closed.
func drain(s *Sub) (events []Event, closed bool) {
	for {
		select {
		case ev, ok := <-s.C:
			if !ok {
				return events, true
			}
			events = append(events, ev)
		default:
			return events, false
		}
	}
}

func names(events []Event) []string {
	out := []string{}
	for _, ev := range events {
		out = append(out, ev.Name)
	}
	return out
}

func TestFanOut(t *testing.T) {
	b := New()
	one, two := b.Subscribe(), b.Subscribe()

	b.Publish(TransfersChanged, TransfersChangedData{ID: "t1"})
	b.Publish(NotifyOS, NotifyOSData{EventID: "job.completed", Title: "Copy finished"})

	for _, s := range []*Sub{one, two} {
		events, closed := drain(s)
		if got := names(events); closed || !slices.Equal(got, []string{TransfersChanged, NotifyOS}) {
			t.Errorf("got %v (closed %v)", got, closed)
		}
	}
	events, _ := drain(b.Subscribe())
	if len(events) != 0 {
		t.Errorf("a new subscriber got %v: there is no replay", names(events))
	}
	b.Publish(TransfersChanged, TransfersChangedData{ID: "t2"})
	if got, _ := drain(one); len(got) != 1 || got[0].Data.(TransfersChangedData).ID != "t2" {
		t.Errorf("event = %+v", got)
	}
}

// Heard is closed by the first subscription, and stays closed.
func TestHeard(t *testing.T) {
	b := New()
	select {
	case <-b.Heard():
		t.Fatal("heard before anything subscribed")
	default:
	}
	b.Subscribe().Close()
	b.Subscribe().Close() // a second subscription doesn't close it again
	select {
	case <-b.Heard():
	default:
		t.Fatal("not heard after a subscription")
	}
}

func TestClose(t *testing.T) {
	b := New()
	s, other := b.Subscribe(), b.Subscribe()
	s.Close()
	s.Close() // closing again is harmless
	if _, closed := drain(s); !closed {
		t.Error("Close did not close C")
	}
	b.Publish(TemplatesChanged, nil)
	if events, closed := drain(other); closed || len(events) != 1 {
		t.Errorf("another subscriber: %v, closed %v", names(events), closed)
	}
	other.Close()
	b.Publish(TemplatesChanged, nil) // nobody left
}

func TestASlowSubscriberIsClosedNotWaitedFor(t *testing.T) {
	b := New()
	slow := b.Subscribe()
	fast := b.Subscribe()
	var got atomic.Int64
	done := make(chan struct{})
	go func() {
		defer close(done)
		for range fast.C {
			got.Add(1)
		}
	}()

	// The fast reader gets time to catch up before the last ten events. Otherwise, under load,
	// it could fall a whole buffer behind and be closed too, which would be correct behavior but
	// would fail the test.
	published := make(chan struct{})
	go func() {
		for range buffer {
			b.Publish(TransfersChanged, nil)
		}
		for deadline := time.Now().Add(5 * time.Second); got.Load() < buffer && time.Now().Before(deadline); {
			time.Sleep(time.Millisecond)
		}
		for i := buffer; i < buffer+10; i++ {
			b.Publish(TransfersChanged, nil)
		}
		close(published)
	}()
	select {
	case <-published:
	case <-time.After(5 * time.Second):
		t.Fatal("Publish blocked on a subscriber that does not read")
	}

	events, closed := drain(slow)
	if !closed || len(events) != buffer {
		t.Errorf("slow subscriber: %d events, closed %v; want %d and closed", len(events), closed, buffer)
	}
	fast.Close()
	<-done
	if n := got.Load(); n != buffer+10 {
		t.Errorf("fast subscriber got %d events, want %d", n, buffer+10)
	}
}

func TestConcurrentUse(t *testing.T) {
	b := New()
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 200 {
				b.Publish(RemotesChanged, nil)
			}
		})
		wg.Go(func() {
			for range 50 {
				s := b.Subscribe()
				drain(s)
				s.Close()
			}
		})
	}
	wg.Wait()
}

func TestPayloadShapes(t *testing.T) {
	for _, c := range []struct {
		data any
		want string
	}{
		{TransfersChangedData{ID: "1", State: "running", Operation: "delete", Sources: []string{"a:"}},
			`{"id":"1","state":"running","operation":"delete","sources":["a:"]}`},
		{TransfersProgressData{Items: map[string]TransferProgress{"1": {Seq: 3, State: "running"}}},
			`{"items":{"1":{"seq":3,"state":"running","bytes":0,"totalBytes":0,"speed":0,"eta":null,"pct":0,"files":0,"totalFiles":0,"errors":0,"checks":0,"listed":0,"transferring":null,"checking":null,"transferred":null}}}`},
		{RemotesChangedData{Names: []string{"a", "b"}}, `{"names":["a","b"]}`},
		{RemotesChangedData{}, `{}`},
		{RemotesHealthData{ID: "s3", State: "faulty", Error: "x"}, `{"id":"s3","state":"faulty","error":"x"}`},
		{RemotesHealthData{ID: "s3", State: "ok"}, `{"id":"s3","state":"ok"}`},
		{MountsChangedData{ID: "m", State: "starting", MountPoint: "/mnt"}, `{"id":"m","state":"starting","mountPoint":"/mnt"}`},
		{ServesChangedData{ID: "s", State: "failed", Error: "bind"}, `{"id":"s","state":"failed","error":"bind"}`},
		{PrefsChangedData{Names: []string{"theme"}}, `{"names":["theme"]}`},
		{NotifyOSData{EventID: "job.failed", Title: "t", Body: "b"}, `{"eventId":"job.failed","title":"t","body":"b"}`},
		{NotifyOSData{EventID: "job.failed", Title: "t", Body: "b", Route: "/transfers?id=1", ToastOnly: true},
			`{"eventId":"job.failed","title":"t","body":"b","route":"/transfers?id=1","toastOnly":true}`},
	} {
		got, err := json.Marshal(c.data)
		if err != nil || string(got) != c.want {
			t.Errorf("%T = %s, %v; want %s", c.data, got, err, c.want)
		}
	}
}
