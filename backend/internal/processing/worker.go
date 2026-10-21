package processing

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/Axepuff/choral-training-tool/backend/internal/storage"
	"github.com/Axepuff/choral-training-tool/backend/internal/users"
)

type Runner struct {
	db      *sql.DB
	store   *storage.Store
	timeout time.Duration
}
type job struct {
	id, asset, source, track, song string
	attempt                        int
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// New runs once before the listener, following uploads' filesystem recovery.
// The ADR permits only one service process per data directory.
func New(ctx context.Context, db *sql.DB, store *storage.Store) (*Runner, error) {
	if e := CheckTools(ctx); e != nil {
		return nil, e
	}
	r := &Runner{db: db, store: store, timeout: 5 * time.Minute}
	_, e := db.ExecContext(ctx, `UPDATE jobs SET lease_until=NULL WHERE state='processing'`)
	return r, e
}

func (r *Runner) claim(ctx context.Context) (*job, error) {
	tx, e := r.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	now := stamp(time.Now())
	// Recover interrupted attempts. An exhausted job remains failed with its original.
	_, e = tx.ExecContext(ctx, `UPDATE jobs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error_code='processing_interrupted',lease_until=NULL,updated_at=? WHERE state='processing' AND (lease_until IS NULL OR lease_until<=?)`, now, now)
	if e != nil {
		return nil, e
	}
	_, e = tx.ExecContext(ctx, `UPDATE assets SET state='failed',updated_at=? WHERE state='processing' AND id IN (SELECT asset_id FROM jobs WHERE state='failed')`, now)
	if e != nil {
		return nil, e
	}
	_, e = tx.ExecContext(ctx, `UPDATE jobs SET state='canceled',lease_until=NULL,updated_at=? WHERE state IN ('queued','processing') AND NOT EXISTS (SELECT 1 FROM assets a JOIN tracks t ON t.id=a.track_id JOIN songs s ON s.id=t.song_id WHERE a.id=jobs.asset_id AND a.state IN ('pending','processing') AND t.pending_asset_id=a.id AND t.deleted_at IS NULL AND s.deleted_at IS NULL)`, now)
	if e != nil {
		return nil, e
	}
	j := &job{}
	e = tx.QueryRowContext(ctx, `SELECT j.id,a.id,a.source_path,t.id,t.song_id,j.attempts+1 FROM jobs j JOIN assets a ON a.id=j.asset_id JOIN tracks t ON t.id=a.track_id WHERE j.state='queued' AND j.attempts<3 AND (j.lease_until IS NULL OR j.lease_until<=?) AND (SELECT count(*) FROM jobs WHERE state='processing')<2 AND NOT EXISTS (SELECT 1 FROM jobs busy JOIN assets ba ON ba.id=busy.asset_id JOIN tracks bt ON bt.id=ba.track_id WHERE busy.state='processing' AND bt.song_id=t.song_id) ORDER BY j.created_at,j.id LIMIT 1`, now).Scan(&j.id, &j.asset, &j.source, &j.track, &j.song, &j.attempt)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, tx.Commit()
	}
	if e != nil {
		return nil, e
	}
	_, e = tx.ExecContext(ctx, `UPDATE jobs SET state='processing',attempts=?,lease_until=?,error_code=NULL,updated_at=? WHERE id=?`, j.attempt, stamp(time.Now().Add(r.timeout+time.Minute)), now, j.id)
	if e == nil {
		_, e = tx.ExecContext(ctx, `UPDATE assets SET state='processing',updated_at=? WHERE id=?`, now, j.asset)
	}
	if e != nil {
		return nil, e
	}
	return j, tx.Commit()
}

// Run returns only after both subprocess slots stop, before DB/Storage close.
func (r *Runner) Run(ctx context.Context) {
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for ctx.Err() == nil {
				j, e := r.claim(ctx)
				if e == nil && j != nil {
					r.process(ctx, j)
					continue
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Second):
				}
			}
		}()
	}
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	_ = r.cleanup(ctx)
	for ctx.Err() == nil {
		select {
		case <-ctx.Done():
		case <-ticker.C:
			_ = r.cleanup(ctx)
		}
	}
	wg.Wait()
}

func (r *Runner) process(parent context.Context, j *job) {
	ctx, cancel := context.WithTimeout(parent, r.timeout)
	defer cancel()
	playback, peaks := "playback-"+users.ID(), "peaks-"+users.ID()
	stages := []string{"stage-" + users.ID(), "stage-" + users.ID()}
	committed := false
	defer func() {
		for _, k := range stages {
			_ = r.store.Remove(context.Background(), k)
		}
		if !committed {
			_ = r.store.Remove(context.Background(), playback)
			_ = r.store.Remove(context.Background(), peaks)
		}
	}()
	code := "storage_error"
	duration, e := r.convert(ctx, j.source, stages[0], stages[1])
	if e == nil {
		e = r.store.Publish(ctx, stages[0], playback)
	}
	if e == nil {
		e = r.store.Publish(ctx, stages[1], peaks)
	}
	if e == nil {
		committed, e = r.complete(ctx, j, playback, peaks, duration)
		if e == nil && !committed {
			return
		}
	}
	if e != nil {
		if parent.Err() != nil {
			return
		} // Leave lease for restart recovery; do not lose source.
		if ctx.Err() != nil {
			code = "processing_timeout"
		} else {
			var media *mediaError
			if errors.As(e, &media) {
				code = media.code
			}
		}
		_ = r.failed(parent, j, code)
		return
	}
	_ = r.cleanup(parent)
}

type mediaError struct{ code string }

func (e *mediaError) Error() string { return e.code }
func (r *Runner) convert(ctx context.Context, source, out, peaks string) (int64, error) {
	input, e := r.store.Open(ctx, source)
	if e != nil {
		return 0, e
	}
	defer input.Close()
	output, e := r.store.CreateStage(out)
	if e != nil {
		return 0, e
	}
	defer output.Close()
	c := command(ctx, "ffmpeg", []*os.File{input.(*os.File), output}, "-nostdin", "-v", "error", "-xerror", "-max_alloc", "67108864", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", "wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff,asf", "-i", "/proc/self/fd/3", "-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1", "-ac", "1", "-ar", "48000", "-af", "asetpts=N/SR/TB", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "96k", "-threads", "1", "-f", "mp4", "-y", "/proc/self/fd/4")
	var diagnostic bounded
	c.Stderr = &diagnostic
	if e = c.Run(); e != nil {
		// Diagnostics are used only for classification, never exposed or logged.
		text := string(diagnostic.data)
		for _, temporary := range []string{"No space left on device", "Input/output error", "Permission denied", "failed to execute"} {
			if strings.Contains(text, temporary) {
				return 0, e
			}
		}
		return 0, &mediaError{"decode_failed"}
	}
	if e = output.Sync(); e != nil {
		return 0, e
	}
	duration, e := verify(ctx, output)
	if e != nil {
		if errors.Is(e, context.DeadlineExceeded) {
			return 0, &mediaError{"processing_timeout"}
		}
		return 0, &mediaError{"invalid_result"}
	}
	c = command(ctx, "ffmpeg", []*os.File{output}, "-nostdin", "-v", "error", "-xerror", "-threads", "1", "-protocol_whitelist", "file,pipe", "-i", "/proc/self/fd/3", "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-threads", "1", "-f", "f32le", "pipe:1")
	pipe, e := c.StdoutPipe()
	if e != nil {
		return 0, e
	}
	if e = c.Start(); e != nil {
		return 0, e
	}
	w, readErr := readWave(pipe)
	if readErr != nil {
		_ = c.Process.Kill()
	}
	e = c.Wait()
	if e != nil || readErr != nil {
		return 0, &mediaError{"invalid_result"}
	}
	// AAC pads the final frame. MP4 edit-list duration excludes that padding;
	// preserve t=0 and crop only the final decoded window to that timeline.
	if w.Duration < duration || w.Duration-duration > 22 {
		return 0, &mediaError{"invalid_result"}
	}
	w.Duration = duration
	w.Points = w.Points[:(duration+99)/100]
	b, e := json.Marshal(w)
	if e != nil {
		return 0, e
	}
	if e = r.store.Stage(ctx, peaks, bytes.NewReader(b), 1<<20); e != nil {
		return 0, e
	}
	return duration, nil
}
func (r *Runner) complete(ctx context.Context, j *job, playback, peaks string, duration int64) (bool, error) {
	tx, e := r.db.BeginTx(ctx, nil)
	if e != nil {
		return false, e
	}
	defer tx.Rollback()
	var old sql.NullString
	e = tx.QueryRowContext(ctx, `SELECT t.active_asset_id FROM tracks t JOIN songs s ON s.id=t.song_id JOIN assets a ON a.id=t.pending_asset_id JOIN jobs j ON j.asset_id=a.id WHERE t.id=? AND a.id=? AND a.track_id=t.id AND a.state='processing' AND t.deleted_at IS NULL AND s.deleted_at IS NULL AND j.id=? AND j.state='processing' AND j.attempts=?`, j.track, j.asset, j.id, j.attempt).Scan(&old)
	if errors.Is(e, sql.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	now := stamp(time.Now())
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE assets SET state='ready',playback_path=?,peaks_path=?,duration_ms=?,mime='audio/mp4',sample_rate=48000,channels=1,updated_at=? WHERE id=?`, []any{playback, peaks, duration, now, j.asset}},
		{`UPDATE assets SET state='retired',updated_at=? WHERE track_id=? AND id!=? AND (id=? OR state='failed')`, []any{now, j.track, j.asset, old}},
		{`UPDATE tracks SET active_asset_id=?,pending_asset_id=NULL WHERE id=?`, []any{j.asset, j.track}},
		{`UPDATE jobs SET state='succeeded',lease_until=NULL,error_code=NULL,updated_at=? WHERE id=?`, []any{now, j.id}},
		{`UPDATE songs SET version=version+1,updated_at=? WHERE id=?`, []any{now, j.song}},
	} {
		if _, e = tx.ExecContext(ctx, q.sql, q.args...); e != nil {
			return false, e
		}
	}
	e = tx.Commit()
	return e == nil, e
}
func (r *Runner) failed(ctx context.Context, j *job, code string) error {
	tx, e := r.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	state := "failed"
	if j.attempt < 3 && (code == "storage_error" || code == "processing_timeout") {
		state = "queued"
	}
	res, e := tx.ExecContext(ctx, `UPDATE jobs SET state=?,error_code=?,lease_until=?,updated_at=? WHERE id=? AND state='processing' AND attempts=?`, state, code, stamp(time.Now().Add(5*time.Second)), stamp(time.Now()), j.id, j.attempt)
	if e != nil {
		return e
	}
	n, e := res.RowsAffected()
	if e != nil {
		return e
	}
	if n == 0 {
		return nil
	}
	assetState := "failed"
	if state == "queued" {
		assetState = "pending"
	}
	_, e = tx.ExecContext(ctx, `UPDATE assets SET state=?,updated_at=? WHERE id=? AND state='processing'`, assetState, stamp(time.Now()), j.asset)
	if e != nil {
		return e
	}
	return tx.Commit()
}

// At most 64 assets per pass. Failed originals are never age-expired. Retired
// objects need 24h grace and no active/pending reference or in-flight job.
func (r *Runner) cleanup(ctx context.Context) error {
	tx, e := r.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	rows, e := tx.QueryContext(ctx, `SELECT a.id,a.source_path,COALESCE(a.playback_path,''),COALESCE(a.peaks_path,''),a.state FROM assets a WHERE (a.state='ready' AND a.source_path!='') OR (a.state='retired' AND (a.source_path!='' OR a.playback_path IS NOT NULL OR a.peaks_path IS NOT NULL) AND a.updated_at<? AND NOT EXISTS(SELECT 1 FROM tracks t WHERE t.active_asset_id=a.id OR t.pending_asset_id=a.id) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.asset_id=a.id AND j.state IN ('processing','queued'))) LIMIT 64`, stamp(time.Now().Add(-24*time.Hour)))
	if e != nil {
		return e
	}
	type item struct{ id, source, playback, peaks, state string }
	var items []item
	for rows.Next() {
		var v item
		if e = rows.Scan(&v.id, &v.source, &v.playback, &v.peaks, &v.state); e != nil {
			break
		}
		items = append(items, v)
	}
	re := rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	if re != nil {
		return re
	}
	for _, v := range items {
		keys := []string{v.source}
		if v.state == "retired" {
			keys = append(keys, v.playback, v.peaks)
		}
		for _, k := range keys {
			if k != "" {
				if e = r.store.Remove(ctx, k); e != nil {
					return e
				}
			}
		}
		if v.state == "ready" {
			_, e = tx.ExecContext(ctx, `UPDATE assets SET source_path='' WHERE id=?`, v.id)
		} else {
			_, e = tx.ExecContext(ctx, `UPDATE assets SET source_path='',playback_path=NULL,peaks_path=NULL WHERE id=?`, v.id)
		}
		if e != nil {
			return e
		}
	}
	return tx.Commit()
}
