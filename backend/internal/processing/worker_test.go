package processing

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/platform"
	"github.com/Axepuff/choral-training-tool/backend/internal/storage"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type fixture struct {
	t     *testing.T
	db    *sql.DB
	store *storage.Store
	r     *Runner
	dir   string
}

func setup(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	db, e := platform.OpenDatabase(ctx, dir)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { db.Close() })
	st, e := storage.New(dir)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { st.Close() })
	r, e := New(ctx, db, st)
	if e != nil {
		t.Fatal(e)
	}
	f := &fixture{t, db, st, r, dir}
	f.exec(`INSERT INTO users(id,email_normalized,password_hash,role,created_at,updated_at) VALUES('owner','fiction@example.test','unused','teacher',?,?)`, stamp(time.Now()), stamp(time.Now()))
	return f
}
func (f *fixture) exec(q string, args ...any) {
	f.t.Helper()
	if _, e := f.db.Exec(q, args...); e != nil {
		f.t.Fatal(e)
	}
}
func (f *fixture) str(q string, args ...any) string {
	f.t.Helper()
	var s string
	if e := f.db.QueryRow(q, args...).Scan(&s); e != nil {
		f.t.Fatal(e)
	}
	return s
}
func (f *fixture) add(format string) (j *job) {
	f.t.Helper()
	ctx := context.Background()
	j = &job{id: users.ID(), asset: users.ID(), track: users.ID(), song: users.ID(), source: "original-" + users.ID()}
	now := stamp(time.Now())
	source := filepath.Join(f.t.TempDir(), "input."+format)
	c := exec.Command(fixtureFFmpeg(), "-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=0.35", "-ac", "2", source)
	if b, e := c.CombinedOutput(); e != nil {
		f.t.Fatalf("fixture: %v %s", e, b)
	}
	b, e := os.ReadFile(source)
	if e != nil {
		f.t.Fatal(e)
	}
	stage := "stage-" + users.ID()
	if e = f.store.Stage(ctx, stage, bytes.NewReader(b), 100<<20); e != nil {
		f.t.Fatal(e)
	}
	if e = f.store.Publish(ctx, stage, j.source); e != nil {
		f.t.Fatal(e)
	}
	f.exec(`INSERT INTO songs(id,owner_id,title,bpm,beats_per_bar,beat_unit,created_at,updated_at) VALUES(?,'owner','test',120,4,4,?,?)`, j.song, now, now)
	f.exec(`INSERT INTO tracks(id,song_id,position,name) VALUES(?,?,0,'voice')`, j.track, j.song)
	f.exec(`INSERT INTO assets(id,track_id,source_path,source_bytes,source_sha256,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)`, j.asset, j.track, j.source, len(b), []byte("test"), now, now)
	f.exec(`UPDATE tracks SET pending_asset_id=? WHERE id=?`, j.asset, j.track)
	f.exec(`INSERT INTO jobs(id,asset_id,state,created_at,updated_at) VALUES(?,?,'queued',?,?)`, j.id, j.asset, now, now)
	return
}
func (f *fixture) claim() *job {
	f.t.Helper()
	j, e := f.r.claim(context.Background())
	if e != nil || j == nil {
		f.t.Fatalf("claim %v %v", j, e)
	}
	return j
}
func (f *fixture) exists(key string) bool {
	f.t.Helper()
	v, e := f.store.Open(context.Background(), key)
	if e == nil {
		v.Close()
		return true
	}
	return false
}

func TestRealFormatsAndArtifacts(t *testing.T) {
	for _, format := range []string{"wav", "flac", "mp3", "ogg", "m4a", "aiff", "aac", "wma", "webm"} {
		t.Run(format, func(t *testing.T) {
			f := setup(t)
			j := f.add(format)
			f.r.process(context.Background(), f.claim())
			if s := f.str(`SELECT state FROM jobs WHERE id=?`, j.id); s != "succeeded" {
				t.Fatal(s, f.str(`SELECT COALESCE(error_code,'') FROM jobs WHERE id=?`, j.id))
			}
			if f.exists(j.source) || f.str(`SELECT source_path FROM assets WHERE id=?`, j.asset) != "" {
				t.Fatal("original not cleaned after commit")
			}
			if f.str(`SELECT active_asset_id FROM tracks WHERE id=?`, j.track) != j.asset {
				t.Fatal("not activated")
			}
			key := f.str(`SELECT playback_path FROM assets WHERE id=?`, j.asset)
			media, e := f.store.Open(context.Background(), key)
			if e != nil {
				t.Fatal(e)
			}
			defer media.Close()
			duration, e := verify(context.Background(), media.(*os.File))
			if e != nil {
				t.Fatal(e)
			}
			if duration < 300 || duration > 500 {
				t.Fatal(duration)
			}
			p, e := f.store.Open(context.Background(), f.str(`SELECT peaks_path FROM assets WHERE id=?`, j.asset))
			if e != nil {
				t.Fatal(e)
			}
			defer p.Close()
			var w wave
			if e = json.NewDecoder(p).Decode(&w); e != nil {
				t.Fatal(e)
			}
			if w.Duration != duration || w.Step != 100 || len(w.Points) != int((duration+99)/100) {
				t.Fatal(w)
			}
			audible := false
			for _, v := range w.Points {
				if v[0] < -0.01 && v[1] > 0.01 {
					audible = true
				}
			}
			if !audible {
				t.Fatal("fake/silent peaks")
			}
		})
	}
}

func TestClaimLimitsRecoveryAndFencing(t *testing.T) {
	f := setup(t)
	a := f.add("wav")
	b := f.add("flac")
	f.add("wav")
	f.exec(`UPDATE tracks SET song_id=?,position=1 WHERE id=?`, a.song, b.track)
	one := f.claim()
	two := f.claim()
	if one.song == two.song {
		t.Fatal("same-song concurrency")
	}
	if j, e := f.r.claim(context.Background()); e != nil || j != nil {
		t.Fatal("server limit", j, e)
	}
	f.exec(`UPDATE jobs SET lease_until=NULL WHERE id=?`, one.id)
	recovered := f.claim()
	if recovered.id != one.id || recovered.attempt != 2 {
		t.Fatal("recovery", recovered)
	}
	ok, e := f.r.complete(context.Background(), one, "playback-"+users.ID(), "peaks-"+users.ID(), 350)
	if e != nil || ok {
		t.Fatal("stale attempt published", ok, e)
	}
	f.r.process(context.Background(), recovered)
	if f.str(`SELECT state FROM jobs WHERE id=?`, recovered.id) != "succeeded" {
		t.Fatal("restart did not complete")
	}
}

func TestFailuresKeepOriginalAndOldAsset(t *testing.T) {
	for _, mode := range []string{"corrupt", "timeout", "disk", "disk_fs", "commit", "deleted"} {
		t.Run(mode, func(t *testing.T) {
			f := setup(t)
			old := f.add("wav")
			f.r.process(context.Background(), f.claim())
			oldKey := f.str(`SELECT playback_path FROM assets WHERE id=?`, old.asset)
			j := f.add("flac")
			f.exec(`UPDATE tracks SET pending_asset_id=NULL WHERE id=?`, j.track)
			f.exec(`UPDATE assets SET track_id=? WHERE id=?`, old.track, j.asset)
			f.exec(`UPDATE tracks SET pending_asset_id=? WHERE id=?`, j.asset, old.track)
			claimed := f.claim()
			switch mode {
			case "corrupt":
				if e := os.WriteFile(filepath.Join(f.dir, "files", j.source), []byte("invalid"), 0600); e != nil {
					t.Fatal(e)
				}
			case "timeout":
				f.r.timeout = time.Nanosecond
			case "disk_fs":
				if e := os.Chmod(filepath.Join(f.dir, "files"), 0500); e != nil {
					t.Fatal(e)
				}
				t.Cleanup(func() { _ = os.Chmod(filepath.Join(f.dir, "files"), 0700) })
			case "disk":
				f.exec(`CREATE TRIGGER reject_ready BEFORE UPDATE OF state ON assets WHEN NEW.state='ready' BEGIN SELECT RAISE(ABORT,'disk full'); END`)
			case "commit":
				f.exec(`CREATE TRIGGER reject_success BEFORE UPDATE OF state ON jobs WHEN NEW.state='succeeded' BEGIN SELECT RAISE(ABORT,'result failure'); END`)
			case "deleted":
				f.exec(`UPDATE songs SET deleted_at=? WHERE id=?`, stamp(time.Now()), old.song)
				f.exec(`UPDATE tracks SET active_asset_id=NULL,pending_asset_id=NULL,deleted_at=? WHERE id=?`, stamp(time.Now()), old.track)
				f.exec(`UPDATE jobs SET state='canceled' WHERE id=?`, claimed.id)
			}
			f.r.process(context.Background(), claimed)
			if mode == "disk_fs" {
				_ = os.Chmod(filepath.Join(f.dir, "files"), 0700)
			}
			if !f.exists(j.source) || !f.exists(oldKey) {
				t.Fatal("lost source/old playback")
			}
			if mode != "deleted" && f.str(`SELECT active_asset_id FROM tracks WHERE id=?`, old.track) != old.asset {
				t.Fatal("replaced on failure")
			}
			if f.str(`SELECT state FROM jobs WHERE id=?`, j.id) == "succeeded" {
				t.Fatal("false success")
			}
			if mode == "timeout" || mode == "disk" || mode == "disk_fs" || mode == "commit" {
				f.r.timeout = 5 * time.Minute
				f.exec(`DROP TRIGGER IF EXISTS reject_ready`)
				f.exec(`DROP TRIGGER IF EXISTS reject_success`)
				f.exec(`UPDATE jobs SET lease_until=NULL WHERE id=?`, j.id)
				f.r.process(context.Background(), f.claim())
				if f.str(`SELECT active_asset_id FROM tracks WHERE id=?`, old.track) != j.asset {
					t.Fatal("retry failed")
				}
				if f.exists(j.source) {
					t.Fatal("original remains")
				}
				if !f.exists(oldKey) {
					t.Fatal("grace ignored")
				}
			}
		})
	}
}

func TestCleanupGraceAndFailedRetention(t *testing.T) {
	f := setup(t)
	j := f.add("wav")
	f.r.process(context.Background(), f.claim())
	key := f.str(`SELECT playback_path FROM assets WHERE id=?`, j.asset)
	f.exec(`UPDATE tracks SET active_asset_id=NULL WHERE id=?`, j.track)
	f.exec(`UPDATE assets SET state='retired' WHERE id=?`, j.asset)
	if e := f.r.cleanup(context.Background()); e != nil {
		t.Fatal(e)
	}
	if !f.exists(key) {
		t.Fatal("grace")
	}
	f.exec(`UPDATE assets SET updated_at=? WHERE id=?`, stamp(time.Now().Add(-25*time.Hour)), j.asset)
	if e := f.r.cleanup(context.Background()); e != nil {
		t.Fatal(e)
	}
	if f.exists(key) {
		t.Fatal("not removed")
	}
	failed := f.add("wav")
	f.exec(`UPDATE assets SET state='failed',updated_at=? WHERE id=?`, stamp(time.Now().Add(-48*time.Hour)), failed.asset)
	f.exec(`UPDATE jobs SET state='failed' WHERE id=?`, failed.id)
	if e := f.r.cleanup(context.Background()); e != nil {
		t.Fatal(e)
	}
	if !f.exists(failed.source) {
		t.Fatal("failed original expired")
	}
}

func TestRetryExhaustionAndShutdown(t *testing.T) {
	f := setup(t)
	j := f.add("wav")
	claimed := f.claim()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f.r.process(ctx, claimed)
	if !f.exists(j.source) || f.str(`SELECT state FROM jobs WHERE id=?`, j.id) != "processing" {
		t.Fatal("shutdown lost recovery")
	}
	for n := 2; n <= 3; n++ {
		f.exec(`UPDATE jobs SET lease_until=NULL WHERE id=?`, j.id)
		claimed = f.claim()
		if claimed.attempt != n {
			t.Fatal(claimed)
		}
	}
	f.exec(`UPDATE jobs SET lease_until=NULL WHERE id=?`, j.id)
	if got, e := f.r.claim(context.Background()); e != nil || got != nil {
		t.Fatal(got, e)
	}
	if f.str(`SELECT state FROM jobs WHERE id=?`, j.id) != "failed" || !f.exists(j.source) {
		t.Fatal("exhausted attempt")
	}
}

// This child is killed by the parent while FFmpeg is producing a real stage.
func TestKilledWorkerHelper(t *testing.T) {
	if len(os.Args) < 3 || os.Args[len(os.Args)-2] != "worker-helper" {
		return
	}
	dir := os.Args[len(os.Args)-1]
	db, e := platform.OpenDatabase(context.Background(), dir)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	st, e := storage.New(dir)
	if e != nil {
		t.Fatal(e)
	}
	defer st.Close()
	r, e := New(context.Background(), db, st)
	if e != nil {
		t.Fatal(e)
	}
	j, e := r.claim(context.Background())
	if e != nil || j == nil {
		t.Fatal(e)
	}
	r.process(context.Background(), j)
}

func TestKillRestartDuringConversion(t *testing.T) {
	f := setup(t)
	j := f.add("flac")
	// Long but compressible synthetic input keeps the actual conversion in flight.
	input := filepath.Join(t.TempDir(), "long.flac")
	if b, e := exec.Command(fixtureFFmpeg(), "-v", "error", "-f", "lavfi", "-i", "sine=duration=1190:sample_rate=48000", "-y", input).CombinedOutput(); e != nil {
		t.Fatalf("%v %s", e, b)
	}
	b, e := os.ReadFile(input)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(f.dir, "files", j.source), b, 0600); e != nil {
		t.Fatal(e)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestKilledWorkerHelper$", "worker-helper", f.dir)
	var log bytes.Buffer
	child.Stdout = &log
	child.Stderr = &log
	if e = child.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		if child.ProcessState == nil {
			_ = child.Process.Kill()
			_ = child.Wait()
		}
	}()
	deadline := time.Now().Add(15 * time.Second)
	found := false
	for time.Now().Before(deadline) {
		entries, e := os.ReadDir(filepath.Join(f.dir, "files"))
		if e != nil {
			t.Fatal(e)
		}
		for _, v := range entries {
			if strings.HasPrefix(v.Name(), "stage-") {
				st, e := v.Info()
				if e == nil && st.Size() > 4096 {
					found = true
				}
			}
		}
		if found {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !found {
		t.Fatal("no in-flight stage", log.String())
	}
	if e = child.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	_ = child.Wait()
	if !f.exists(j.source) {
		t.Fatal("crash lost original")
	}
	if f.str(`SELECT state FROM jobs WHERE id=?`, j.id) != "processing" {
		t.Fatal("not killed during processing")
	}
	// Reopen durable state just as service startup does. Recovery removes stages,
	// retains referenced originals, and resets interrupted leases.
	if e = f.store.Recover(map[string]bool{j.source: true}); e != nil {
		t.Fatal(e)
	}
	f.r, e = New(context.Background(), f.db, f.store)
	if e != nil {
		t.Fatal(e)
	}
	recovered := f.claim()
	if recovered.attempt != 2 {
		t.Fatal(recovered)
	}
	f.r.process(context.Background(), recovered)
	if f.str(`SELECT state FROM jobs WHERE id=?`, j.id) != "succeeded" || f.exists(j.source) {
		t.Fatal("restart failed")
	}
}

func TestCompletionOrderAndCleanupRetry(t *testing.T) {
	f := setup(t)
	j := f.add("wav")
	claimed := f.claim()
	ctx := context.Background()
	stage, peakStage := "stage-"+users.ID(), "stage-"+users.ID()
	d, e := f.r.convert(ctx, j.source, stage, peakStage)
	if e != nil {
		t.Fatal(e)
	}
	if !f.exists(j.source) || f.str(`SELECT COALESCE(active_asset_id,'') FROM tracks WHERE id=?`, j.track) != "" {
		t.Fatal("early source deletion/publication")
	}
	playback, peaks := "playback-"+users.ID(), "peaks-"+users.ID()
	if e = f.store.Publish(ctx, stage, playback); e != nil {
		t.Fatal(e)
	}
	if e = f.store.Publish(ctx, peakStage, peaks); e != nil {
		t.Fatal(e)
	}
	ok, e := f.r.complete(ctx, claimed, playback, peaks, d)
	if e != nil || !ok {
		t.Fatal(ok, e)
	}
	if !f.exists(j.source) || !f.exists(playback) || !f.exists(peaks) {
		t.Fatal("commit lost original/result")
	}
	if e = os.Chmod(filepath.Join(f.dir, "files"), 0500); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(f.dir, "files"), 0700) })
	if e = f.r.cleanup(ctx); e == nil {
		t.Fatal("remove failure not reported")
	}
	if !f.exists(j.source) || f.str(`SELECT source_path FROM assets WHERE id=?`, j.asset) == "" {
		t.Fatal("quota released before successful removal")
	}
	if e = os.Chmod(filepath.Join(f.dir, "files"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = f.r.cleanup(ctx); e != nil {
		t.Fatal(e)
	}
	if f.exists(j.source) || !f.exists(playback) || !f.exists(peaks) {
		t.Fatal("cleanup retry")
	}
}

func TestMissingToolsFailStartup(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if e := CheckTools(context.Background()); e == nil {
		t.Fatal("startup accepted missing tools")
	}
}

func TestMissingPCMMuxerFailsStartup(t *testing.T) {
	binary, e := exec.LookPath("ffmpeg")
	if e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	// Model a build with AAC/MP4 but no raw PCM output, delegating all other
	// capability queries to the actual binary. Such a build cannot make peaks.
	script := "#!/bin/sh\nif [ \"$3\" = '-muxers' ]; then\nprintf ' E mp4 MP4\\n'\nelse\nexec \"$CHORAL_TEST_REAL_FFMPEG\" \"$@\"\nfi\n"
	if e = os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte(script), 0700); e != nil {
		t.Fatal(e)
	}
	t.Setenv("CHORAL_TEST_REAL_FFMPEG", binary)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	if e = CheckTools(context.Background()); e == nil {
		t.Fatal("startup accepted AAC build unable to produce peaks")
	}
}

func TestResultProbeTimeoutKeepsOriginal(t *testing.T) {
	f := setup(t)
	j := f.add("wav")
	claimed := f.claim()
	// Simulate a hung result probe, after actual FFmpeg conversion. No source
	// strings enter this script; exec lets cancellation kill sleep directly.
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "ffprobe"), []byte("#!/bin/sh\nexec sleep 30\n"), 0700); e != nil {
		t.Fatal(e)
	}
	path := os.Getenv("PATH")
	t.Setenv("PATH", dir+string(os.PathListSeparator)+path)
	start := time.Now()
	f.r.process(context.Background(), claimed)
	if elapsed := time.Since(start); elapsed < 14*time.Second || elapsed > 25*time.Second {
		t.Fatal("result probe did not obey 15 second budget", elapsed)
	}
	if f.str(`SELECT state FROM jobs WHERE id=?`, j.id) != "queued" ||
		f.str(`SELECT error_code FROM jobs WHERE id=?`, j.id) != "processing_timeout" || !f.exists(j.source) {
		t.Fatal("probe timeout must retain original and allow retry")
	}
	t.Setenv("PATH", path)
	f.exec(`UPDATE jobs SET lease_until=NULL WHERE id=?`, j.id)
	f.r.process(context.Background(), f.claim())
	if f.str(`SELECT state FROM jobs WHERE id=?`, j.id) != "succeeded" || f.exists(j.source) {
		t.Fatal("retry after result probe timeout failed")
	}
}

func TestResultProbeRejectsWrongPlaybackFormat(t *testing.T) {
	f := setup(t)
	j := f.add("wav")
	input, e := f.store.Open(context.Background(), j.source)
	if e != nil {
		t.Fatal(e)
	}
	defer input.Close()
	if _, e = verify(context.Background(), input.(*os.File)); e == nil {
		t.Fatal("accepted stereo PCM 44.1kHz as AAC-LC mono 48kHz playback")
	}
	if !f.exists(j.source) {
		t.Fatal("verification deleted original")
	}
}

func TestLeadingSilenceAndGainSurviveConversion(t *testing.T) {
	f := setup(t)
	j := f.add("wav")
	input := filepath.Join(t.TempDir(), "offset.wav")
	// A low-level tone starts at 300ms. Timestamp rebasing must preserve those
	// samples; normalization or trimming would move the onset/change the peaks.
	if b, e := exec.Command(fixtureFFmpeg(), "-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,0.3)\\,0\\,0.05*sin(2*PI*440*t)):s=44100:d=0.7", input).CombinedOutput(); e != nil {
		t.Fatalf("fixture: %v %s", e, b)
	}
	b, e := os.ReadFile(input)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(f.dir, "files", j.source), b, 0600); e != nil {
		t.Fatal(e)
	}
	f.r.process(context.Background(), f.claim())
	p, e := f.store.Open(context.Background(), f.str(`SELECT peaks_path FROM assets WHERE id=?`, j.asset))
	if e != nil {
		t.Fatal(e)
	}
	defer p.Close()
	var w wave
	if e = json.NewDecoder(p).Decode(&w); e != nil {
		t.Fatal(e)
	}
	if w.Duration < 690 || w.Duration > 710 || len(w.Points) < 7 {
		t.Fatal("timeline changed", w)
	}
	for _, point := range w.Points[:2] {
		if math.Abs(point[0]) > 0.001 || math.Abs(point[1]) > 0.001 {
			t.Fatal("leading silence lost", w)
		}
	}
	if amplitude := w.Points[4][1]; amplitude < 0.03 || amplitude > 0.08 {
		t.Fatal("gain changed or tone missing", w)
	}
}

// A minimal deployment build need not include lavfi or fixture encoders.
// Only generation uses this override; probe/conversion always use PATH binaries.
func fixtureFFmpeg() string {
	if binary := os.Getenv("CHORAL_TEST_FIXTURE_FFMPEG"); binary != "" {
		return binary
	}
	return "ffmpeg"
}
