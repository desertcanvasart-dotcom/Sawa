// /review/:token — a traveler's private link to review a tour they took (069).
// Star rating, a few words, and photos or videos, which go straight from the
// browser to storage through a signed link the server issues per file. The
// review waits for Sawa before it is shown on the tour page.
import React, { useEffect, useState } from "react";
import { API_BASE } from "./supabaseClient";
import { fmtDate } from "./dates.js";

const STARS = [1, 2, 3, 4, 5];
const RATING_WORD = { 1: "Poor", 2: "Fair", 3: "Good", 4: "Very good", 5: "Excellent" };

async function post(path, body) {
  const r = await fetch(`${API_BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "That didn't work. Please try again.");
  return j;
}

// PUT the file to the signed upload link, the way Supabase's own client does,
// reporting progress (a phone video can take a while).
function putFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", file);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("The upload didn't finish. Please try again.")));
    xhr.onerror = () => reject(new Error("The upload didn't finish. Check your connection and try again."));
    xhr.send(form);
  });
}

export function ReviewPage({ token }) {
  const base = `/public/reviews/${encodeURIComponent(token)}`;
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [country, setCountry] = useState("");
  const [consent, setConsent] = useState(false);
  const [files, setFiles] = useState([]); // { id, file, preview, kind, progress, key, error }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE}${base}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || "This review link isn't valid.");
        setInfo(j);
        if (j.firstName) setDisplayName((v) => v || j.firstName);
      })
      .catch((e) => setLoadError(e.message));
  }, [base]);

  useEffect(() => () => files.forEach((f) => URL.revokeObjectURL(f.preview)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id, patch) => setFiles((list) => list.map((f) => (f.id === id ? { ...f, ...patch } : f)));

  async function upload(entry) {
    try {
      const { key, uploadUrl } = await post(`${base}/uploads`, { contentType: entry.file.type, size: entry.file.size });
      await putFile(uploadUrl, entry.file, (progress) => update(entry.id, { progress }));
      update(entry.id, { key, progress: 100 });
    } catch (e) {
      update(entry.id, { error: e.message });
    }
  }

  function addFiles(e) {
    const picked = [...(e.target.files || [])];
    e.target.value = "";
    const room = (info?.maxMedia || 6) - files.length;
    if (picked.length > room) setError(`You can add up to ${info?.maxMedia || 6} photos or videos.`);
    const added = picked.slice(0, Math.max(0, room)).map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file, preview: URL.createObjectURL(file), kind: file.type.startsWith("video/") ? "video" : "image", progress: 0, key: null, error: "",
    }));
    setFiles((list) => [...list, ...added]);
    added.forEach(upload);
  }

  function remove(id) {
    setFiles((list) => {
      const f = list.find((x) => x.id === id);
      if (f) URL.revokeObjectURL(f.preview);
      return list.filter((x) => x.id !== id);
    });
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!rating) return setError("Choose a star rating.");
    if (files.some((f) => !f.key && !f.error)) return setError("Wait for your photos and videos to finish uploading.");
    if (files.some((f) => f.error)) return setError("Remove the files that didn't upload, or try adding them again.");
    if (!consent) return setError("Tick the box to let us publish your review.");
    setBusy(true);
    try {
      await post(base, { rating, title, body, displayName, country, consent, media: files.map((f) => f.key) });
      setSent(true);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const shell = (children) => <main className="review-page">{children}</main>;

  if (loadError) return shell(<><h1>Leave a review</h1><div className="auth-error" role="alert">{loadError}</div></>);
  if (!info) return shell(<p>Loading…</p>);
  if (sent || info.state === "sent") {
    return shell(<>
      <h1>Thank you!</h1>
      <p>Your review of <strong>{info.route}</strong> has been sent. We'll publish it on the tour page shortly, so other travelers can read it.</p>
      <a className="btn-pill" href="/">Back to Sawa</a>
    </>);
  }

  const shown = hover || rating;
  return shell(
    <form onSubmit={submit} noValidate>
      <span className="review-kicker">Your review</span>
      <h1>How was {info.route}?</h1>
      <p className="review-sub">You traveled on {fmtDate(info.tourDate)}. Your review helps other travelers choose, and it helps us and your guide do better.</p>

      <fieldset className="review-field">
        <legend>Your rating</legend>
        <div className="review-stars" onMouseLeave={() => setHover(0)}>
          {STARS.map((n) => (
            <button key={n} type="button" className={n <= shown ? "on" : ""} aria-label={`${n} star${n > 1 ? "s" : ""}`} aria-pressed={rating === n}
              onMouseEnter={() => setHover(n)} onFocus={() => setHover(n)} onBlur={() => setHover(0)} onClick={() => setRating(n)}>★</button>
          ))}
          <span className="review-star-word">{shown ? RATING_WORD[shown] : "Tap a star"}</span>
        </div>
      </fieldset>

      <label className="review-field">
        <span>Title <small>(optional)</small></span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="A day we'll never forget" />
      </label>

      <label className="review-field">
        <span>Your review</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={6} required
          placeholder="What did you enjoy? How was your guide, the pace, the group?" />
      </label>

      <div className="review-field">
        <span>Photos and videos <small>(optional, up to {info.maxMedia})</small></span>
        <div className="review-media">
          {files.map((f) => (
            <div className={`review-thumb${f.error ? " bad" : ""}`} key={f.id}>
              {f.kind === "video" ? <video src={f.preview} muted playsInline preload="metadata" /> : <img src={f.preview} alt="" />}
              {!f.key && !f.error && <span className="review-progress">{f.progress}%</span>}
              {f.error && <span className="review-progress">Failed</span>}
              <button type="button" className="review-remove" aria-label="Remove" onClick={() => remove(f.id)}>×</button>
            </div>
          ))}
          {files.length < info.maxMedia && (
            <label className="review-add">
              <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,video/mp4,video/quicktime,video/webm" multiple onChange={addFiles} />
              <span>+ Add</span>
            </label>
          )}
        </div>
        <small className="field-hint">Photos up to {info.imageMaxMb}MB, videos up to {info.videoMaxMb}MB.</small>
        {files.filter((f) => f.error).map((f) => <small className="field-hint review-err" key={f.id}>{f.file.name}: {f.error}</small>)}
      </div>

      <div className="review-two">
        <label className="review-field">
          <span>Name to show</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} required placeholder="Ann S." />
        </label>
        <label className="review-field">
          <span>Country <small>(optional)</small></span>
          <input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={60} placeholder="United Kingdom" />
        </label>
      </div>

      <label className="review-consent">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>Sawa may publish my review, photos and videos on its website with the name above. My email is never shown.</span>
      </label>

      {error && <div className="auth-error" role="alert">{error}</div>}
      <button className="btn-pill review-send" type="submit" disabled={busy}>{busy ? "Sending…" : "Send my review"}</button>
    </form>
  );
}
