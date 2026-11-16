// Sharing a 7shifts log book entry: as text (email, text message, clipboard) or as a
// picture (the phone's share sheet, clipboard, download). It all goes through the
// viewer's own apps; the dashboard itself sends nothing.

import { fmtDateLong, fmtStamp, fmtWeekday, h } from './util.js';

/** Where the page loads a log book attachment from. */
export const logFileHref = (p, a) => `/api/logbook/file?post=${encodeURIComponent(p.id)}&i=${a.i}`;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shareTitle = (p, locName) => `Log book · ${locName} · ${p.category} · ${fmtWeekday(p.business_date)} ${fmtDateLong(p.business_date)}`;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
// Windows won't pass a link over ~2,000 characters to the mail or messages app,
// so long notes are shortened there (Copy text always has the whole note).
const LINK_LIMIT = /Windows/i.test(navigator.userAgent) ? 2000 : 30000;

/**
 * Plain-text version of an entry. `max` shortens the note to that many characters and
 * leaves comments out (to fit a link); `heading` adds the title line (texts have no subject).
 */
function shareText(p, { locName, tz, link, heading = true, max = Infinity }) {
  const posted = fmtStamp(p.created, tz, { withZone: true });
  const by = p.author ? `Posted by ${p.author}${posted ? ` · ${posted}` : ''}` : posted ? `Posted ${posted}` : '';
  const shortened = Number.isFinite(max);
  const lines = heading ? [shareTitle(p, locName), ''] : [];
  if (by) lines.push(by, '');
  if (max < p.message.length) {
    const cut = p.message.slice(0, max);
    const space = cut.search(/\s\S*$/); // end on a whole word when there's one nearby
    lines.push(`${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()}… (shortened)`);
  } else {
    lines.push(p.message);
  }
  if (p.comments.length && !shortened) {
    lines.push('', 'Comments:', ...p.comments.map((c) => {
      const when = fmtStamp(c.created, tz);
      return `${c.author || 'Comment'}${when ? ` (${when})` : ''}: ${c.message}`;
    }));
  }
  if (p.comments.length && shortened) lines.push('', `${plural(p.comments.length, 'comment')} not included`);
  if (p.attachment_count) lines.push('', `📎 ${plural(p.attachment_count, 'attachment')}`);
  lines.push('', `${shortened ? 'Full entry' : 'View it'} in the dashboard: ${link}`);
  return lines.join('\n');
}

/** A mailto:/sms: link for the entry, shortening the note until the link fits. */
function shareHref(make, p, opts) {
  let href = make(shareText(p, opts));
  for (let max = p.message.length; href.length > LINK_LIMIT && max > 0; max = Math.floor(max * 0.8)) {
    href = make(shareText(p, { ...opts, max }));
  }
  return href;
}

// ---------------------------------------------------------------------------
// Picture: the entry drawn on a canvas as a light card, with up to 4 photos
// ---------------------------------------------------------------------------
const PIC = { width: 640, pad: 28, scale: 2, maxHeight: 6000, photos: 4, photoHeight: 420 };
const INK = { bg: '#ffffff', text: '#0b0b0b', text2: '#52514e', muted: '#898781', rule: '#e1e0d9' };
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

const loadImage = (src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});

/** Splits text into lines that fit `width`, keeping the author's line breaks. */
function wrap(ctx, text, width) {
  const out = [];
  const fits = (s) => ctx.measureText(s).width <= width;
  for (const para of String(text).split(/\r?\n/)) {
    let line = '';
    for (let word of para.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (fits(test)) { line = test; continue; }
      if (line) out.push(line);
      while (!fits(word)) { // a word wider than the card (a long link): break it
        let n = 1;
        while (n < word.length && fits(word.slice(0, n + 1))) n++;
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    }
    out.push(line);
  }
  return out;
}

/** The entry as a PNG file. */
async function renderPicture(p, { locName, tz }) {
  const shots = p.attachments.filter((a) => a.image);
  const [logo, ...photos] = await Promise.all([
    loadImage('/fish-shop-logo.png'),
    ...shots.slice(0, PIC.photos).map((a) => loadImage(logFileHref(p, a))),
  ]);
  const X = PIC.pad;
  const CW = PIC.width - 2 * PIC.pad;
  const m = document.createElement('canvas').getContext('2d');
  const ops = [];
  let y = PIC.pad;
  let full = false; // the card reached its height limit: nothing more goes in before the ending
  let limit = PIC.maxHeight;
  const text = (str, size, color, { weight = 400, lh = 1.45, indent = 0 } = {}) => {
    if (full) return;
    const font = `${weight} ${size}px ${FONT}`;
    const step = Math.round(size * lh);
    m.font = font;
    for (const line of wrap(m, str, CW - indent)) {
      if (y + step > limit) { full = true; return; }
      ops.push({ t: 'text', str: line, x: X + indent, y: y + (step - size) / 2, font, color });
      y += step;
    }
  };
  const rule = () => { ops.push({ t: 'rect', x: X, y, w: CW, h: 1, color: INK.rule }); y += 1; };

  // Header: logo, location, category and date
  const top = y;
  const logoH = logo ? 44 : 0;
  const logoW = logo ? Math.round((logo.naturalWidth / logo.naturalHeight) * logoH) : 0;
  if (logo) ops.push({ t: 'img', img: logo, x: X, y, w: logoW, h: logoH });
  const indent = logo ? logoW + 14 : 0;
  text(locName, 19, INK.text, { weight: 650, lh: 1.3, indent });
  text(`${p.category} · ${fmtWeekday(p.business_date)} ${fmtDateLong(p.business_date)}`, 14, INK.text2, { lh: 1.4, indent });
  y = Math.max(y, top + logoH) + 14;
  rule();
  y += 14;

  const posted = fmtStamp(p.created, tz, { withZone: true });
  const by = [p.author && `Posted by ${p.author}`, posted].filter(Boolean).join(' · ');
  if (by) { text(by, 13, INK.muted); y += 4; }
  text(p.message, 16, INK.text);

  // Photos, then anything that couldn't be drawn
  let drawn = 0;
  for (const img of photos) {
    if (!img || full) continue;
    const k = Math.min(CW / img.naturalWidth, PIC.photoHeight / img.naturalHeight, 1);
    const w = Math.round(img.naturalWidth * k);
    const ph = Math.round(img.naturalHeight * k);
    if (y + 12 + ph > PIC.maxHeight) { full = true; continue; }
    y += 12;
    ops.push({ t: 'img', img, x: X, y, w, h: ph, round: 8 });
    y += ph;
    drawn++;
  }
  const others = p.attachments.filter((a) => !a.image);
  const missing = (p.attachments.length ? shots.length : p.attachment_count) - drawn;
  if (others.length || missing > 0) y += 10;
  for (const a of others) text(`📎 ${a.name}`, 13, INK.text2);
  if (missing > 0) text(`📎 ${plural(missing, drawn || others.length ? 'more attachment' : 'attachment')} in the dashboard`, 13, INK.text2);

  // Comments, each with a bar down its left side
  if (p.comments.length) {
    y += 14;
    text('Comments', 13, INK.text2, { weight: 650 });
    for (const c of p.comments) {
      const start = y + 4;
      y = start;
      const when = fmtStamp(c.created, tz);
      text(`${c.author || 'Comment'}${when ? ` · ${when}` : ''}`, 12, INK.muted, { indent: 12 });
      text(c.message, 14, INK.text, { indent: 12 });
      ops.push({ t: 'rect', x: X, y: start, w: 2, h: y - start, color: INK.rule });
    }
  }

  const cutShort = full;
  full = false;
  limit = Infinity;
  if (cutShort) text('… continued in the dashboard', 13, INK.muted);
  y += 16;
  rule();
  y += 10;
  text('From the 7shifts log book', 12, INK.muted);
  y += PIC.pad - 10;

  const canvas = document.createElement('canvas');
  canvas.width = PIC.width * PIC.scale;
  canvas.height = Math.ceil(y * PIC.scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(PIC.scale, PIC.scale);
  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, PIC.width, y);
  ctx.textBaseline = 'top';
  for (const o of ops) {
    if (o.t === 'text') { ctx.font = o.font; ctx.fillStyle = o.color; ctx.fillText(o.str, o.x, o.y); }
    else if (o.t === 'rect') { ctx.fillStyle = o.color; ctx.fillRect(o.x, o.y, o.w, o.h); }
    else {
      ctx.save();
      if (o.round && ctx.roundRect) { ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, o.round); ctx.clip(); }
      ctx.drawImage(o.img, o.x, o.y, o.w, o.h);
      ctx.restore();
    }
  }
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No picture'))), 'image/png'));
  return new File([blob], `log-book-${p.location_id}-${p.business_date}.png`, { type: 'image/png' });
}

// ---------------------------------------------------------------------------
// The Share menu
// ---------------------------------------------------------------------------
let fileShare;
/** Can this browser hand a picture to the phone's (or computer's) share sheet? */
function canShareFiles() {
  if (fileShare === undefined) {
    try {
      fileShare = !!navigator.canShare?.({ files: [new File([''], 'x.png', { type: 'image/png' })] });
    } catch {
      fileShare = false;
    }
  }
  return fileShare;
}

/**
 * The Share button and its menu. As text: Email, Text message, Copy text. As a picture:
 * Share picture… where the browser can share files (phones), otherwise Copy picture and
 * Download picture. `opts` = { locName, tz, link }.
 */
export function shareMenu(p, opts) {
  const subject = shareTitle(p, opts.locName);
  const menu = h('details', { class: 'log-share' });
  const list = h('div', { class: 'log-share-menu', role: 'menu' });
  const close = () => { menu.open = false; };
  const item = (label, attrs) => h(attrs.href ? 'a' : 'button', { role: 'menuitem', ...(attrs.href ? {} : { type: 'button' }), ...attrs }, label);
  /** Shows `msg` on the item for a moment, then puts its label back and closes the menu. */
  const flash = (el, msg) => {
    const label = el.dataset.label;
    el.textContent = msg;
    setTimeout(() => { el.textContent = label; close(); }, 1200);
  };

  // The picture is drawn once, when first needed. Where it goes to the share sheet it's
  // started as soon as the menu opens: phones only allow sharing straight after a tap,
  // so it has to be ready by then.
  let picture = null;
  let pictureFile = null;
  const getPicture = () => (picture ??= renderPicture(p, opts).then((f) => (pictureFile = f)));

  menu.addEventListener('toggle', () => {
    if (!menu.open) return;
    if (canShareFiles()) getPicture().catch(() => {});
    if (list.childElementCount) return;
    const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
    const fine = matchMedia('(pointer: fine)').matches;
    const copyText = item('Copy text', {
      'data-label': 'Copy text',
      onclick: async () => {
        try { await navigator.clipboard.writeText(shareText(p, opts)); flash(copyText, 'Copied'); }
        catch { flash(copyText, 'Couldn’t copy'); }
      },
    });
    const sharePic = canShareFiles() && item('Share picture…', {
      'data-label': 'Share picture…',
      onclick: async () => {
        if (!pictureFile) {
          sharePic.textContent = 'Preparing…';
          try { await getPicture(); } catch { flash(sharePic, 'Couldn’t make it'); return; }
        }
        sharePic.textContent = 'Share picture…';
        try {
          await navigator.share({ files: [pictureFile], title: subject, text: shareText(p, opts) });
          close();
        } catch (err) {
          // Safari refuses a share that waited on the picture; the next tap has it ready.
          if (err.name === 'NotAllowedError') sharePic.textContent = 'Tap again to share';
          else if (err.name === 'AbortError') close();
          else flash(sharePic, 'Couldn’t share');
        }
      },
    });
    const copyPic = !canShareFiles() && fine && typeof ClipboardItem !== 'undefined' && item('Copy picture', {
      'data-label': 'Copy picture',
      onclick: async () => {
        try {
          // A promise keeps the copy inside the click while the picture is drawn.
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': getPicture() })]);
          flash(copyPic, 'Copied');
        } catch {
          flash(copyPic, 'Couldn’t copy');
        }
      },
    });
    const download = !canShareFiles() && item('Download picture', {
      'data-label': 'Download picture',
      onclick: async () => {
        try {
          const file = await getPicture();
          const url = URL.createObjectURL(file);
          h('a', { href: url, download: file.name }).click();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
          close();
        } catch {
          flash(download, 'Couldn’t make it');
        }
      },
    });
    list.append(...[
      item('Email', {
        href: shareHref((t) => `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(crlf(t))}`, p, { ...opts, heading: false }),
        onclick: close,
      }),
      item('Text message', { href: shareHref((t) => `sms:?&body=${encodeURIComponent(t)}`, p, opts), onclick: close }),
      copyText,
      !canShareFiles() && navigator.share
        ? item('Share text…', { onclick: () => { close(); navigator.share({ title: subject, text: shareText(p, opts) }).catch(() => {}); } })
        : null,
      h('div', { class: 'log-share-sep', role: 'separator' }),
      sharePic,
      copyPic,
      download,
    ].filter(Boolean));
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.open) { close(); menu.querySelector('summary').focus(); }
  });
  menu.append(h('summary', { class: 'btn', title: 'Email, text or share this entry' }, 'Share'), list);
  return menu;
}

// One listener closes any open share menu when someone clicks elsewhere.
document.addEventListener('click', (e) => {
  for (const d of document.querySelectorAll('details.log-share[open]')) if (!d.contains(e.target)) d.open = false;
});
