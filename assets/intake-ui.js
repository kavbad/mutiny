// Mutiny intake UI. One renderer, used by the landing preview and by the live conversation with Rebel.
// Mount it on a `.intake` element that has: .top (#orb, #state, #voice, #pcount), #scroller > #flow,
// #answer (#chips, input#text, #mic, #send, #hintl, #hintr).
(function () {
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const escape = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- the field map ----------
  const MW = 600, MH = 340, PL = 44, PT = 16, PB = 38;
  const mx = (v) => PL + v * (MW - PL - 30);
  const my = (v) => PT + (1 - v) * (MH - PT - PB); // y: 0 bottom, 1 top
  const rOf = (size) => (size >= 3 ? 7.5 : size === 2 ? 5.5 : 4);
  function mapSVG(companies, axes, you) {
    const marks = (companies || []).map((c, k) => {
      const x = mx(c.x), y = my(c.y), r = rOf(c.size), left = c.x > 0.85;
      return `<g class="mk ${c.size >= 3 ? "big" : ""}" style="animation-delay:${0.3 + k * 0.06}s"><circle cx="${x}" cy="${y}" r="${r}"/><text x="${left ? x - r - 7 : x + r + 7}" y="${y + 3.5}" ${left ? 'text-anchor="end"' : ""}>${escape(c.name)}${c.confidence === "unsure" ? " ?" : ""}</text></g>`;
    }).join("");
    const yg = you ? `<g class="you"><circle class="rg" cx="${mx(you.x)}" cy="${my(you.y)}" r="8"/><circle cx="${mx(you.x)}" cy="${my(you.y)}" r="6.5"/><text x="${mx(you.x) + 14}" y="${my(you.y) + 4}">${escape(you.label)}</text></g>` : "";
    const ax = axes || { x: ["", ""], y: ["", ""] };
    return `<svg class="map" viewBox="0 0 ${MW} ${MH}"><path class="ax" d="M${PL} ${PT} V${MH - PB} H${MW - 30}"/><text class="axl" x="${PL}" y="${MH - PB + 16}">${escape(ax.x[0])}</text><text class="axl" x="${MW - 30}" y="${MH - PB + 16}" text-anchor="end">${escape(ax.x[1])}</text><text class="axl" transform="translate(${PL - 14} ${MH - PB}) rotate(-90)">${escape(ax.y[0])}</text><text class="axl" transform="translate(${PL - 14} ${PT + 110}) rotate(-90)">${escape(ax.y[1])}</text>${marks}${yg}</svg>`;
  }
  const dots = (n, of) => { const total = Math.min(12, Math.max(1, of || 12)); const on = Math.min(total, n || 0); return `<svg width="${total * 7.8 + 4}" height="12" viewBox="0 0 ${total * 7.8 + 4} 12">${Array.from({ length: total }, (_, i) => `<circle class="dot ${i >= total - on ? "on" : ""}" cx="${5 + i * 7.8}" cy="6" r="3"/>`).join("")}</svg>`; };
  const SPARK = { early: "M0 20 L14 16 L28 13 L42 11 L56 9 L70 6 L84 4 L96 2", late: "M0 20 L28 20 L52 19 L72 14 L84 9 L96 2", steady: "M0 20 L18 16 L38 12 L58 8 L78 5 L96 3" };
  const spark = (kind) => `<svg width="96" height="24" viewBox="0 0 96 24"><path class="line" d="M0 20 L14 16 L28 13 L42 11 L56 9 L70 6 L84 4 L96 2"/><path class="line on" d="${SPARK[kind] || SPARK.steady}"/></svg>`;
  const figure = (f) => `<span>${f.share_of > 0 ? dots(f.share_n, f.share_of) : f.trend && f.trend !== "none" ? spark(f.trend) : ""}<span>${escape(f.label)}</span></span>`;

  function mount(root, opts = {}) {
    const $ = (s) => root.querySelector(s);
    const flow = $("#flow"), scroller = $("#scroller");
    const S = { voice: false, follow: !!opts.follow };
    let onSendFn = null;

    // ---------- presence + voice ----------
    function state(s, label) { const o = $("#orb"); if (!o) return; o.className = "orb " + (s || ""); const st = $("#state"); if (st) st.textContent = label || ({ speaking: "speaking", listening: "listening", thinking: "thinking" })[s] || "here"; }
    let synthVoice = null;
    function pickVoice() { const vs = speechSynthesis.getVoices(); synthVoice = vs.find((v) => /en(-|_)(GB|US)/i.test(v.lang) && /Google|Samantha|Daniel|Karen|Serena|Alex/i.test(v.name)) || vs.find((v) => /^en/i.test(v.lang)) || vs[0] || null; }
    const hasSynth = "speechSynthesis" in window;
    if (hasSynth) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; } else if ($("#voice")) $("#voice").style.display = "none";
    $("#voice")?.addEventListener("click", () => { S.voice = !S.voice; $("#voice").textContent = S.voice ? "Voice on" : "Voice off"; $("#voice").classList.toggle("on", S.voice); if (!S.voice && hasSynth) speechSynthesis.cancel(); });
    function speak(text) { if (!S.voice || !hasSynth) return; const u = new SpeechSynthesisUtterance(String(text).replace(/[“”]/g, "")); if (synthVoice) u.voice = synthVoice; u.rate = 0.98; u.pitch = 1; speechSynthesis.speak(u); }

    function scrollDown() { scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }); }
    function dimOld() { [...flow.querySelectorAll(".turn.on")].slice(0, -1).forEach((t) => t.classList.add("old")); }
    function gen(html, cls) { const g = el("div", "gen " + (cls || ""), html); flow.appendChild(g); requestAnimationFrame(() => requestAnimationFrame(() => g.classList.add("on"))); scrollDown(); return g; }

    // ---------- typesetting ----------
    // A writer paces words onto the page no matter how the text arrives (all at once, or streamed).
    function writer(container, cls, speed) {
      let p = null, buf = "", queue = [], draining = false, ended = false, resolveEnd, sentence = "";
      const done = new Promise((r) => (resolveEnd = r));
      const pace = () => (reduce ? 0 : speed || 24 + Math.random() * 20);
      function tokenize(final) {
        // paragraph breaks become a marker; words are emitted once whitespace follows them
        const re = /(\n\s*\n)|(\S+)(\s+)/g; let m, last = 0;
        while ((m = re.exec(buf))) { if (m[1]) queue.push({ para: true }); else queue.push({ w: m[2], sp: m[3] }); last = re.lastIndex; }
        buf = buf.slice(last);
        if (final && buf.trim()) { queue.push({ w: buf.trim(), sp: "" }); buf = ""; }
        drain();
      }
      async function drain() {
        if (draining) return; draining = true;
        while (queue.length) {
          const t = queue.shift();
          if (t.para) { p = null; sentence = ""; continue; }
          if (!p) { p = el("p"); container.appendChild(p); }
          const sp = el("span", cls || "w", escape(t.w) + (t.sp ? " " : "")); p.appendChild(sp);
          sentence += t.w + " ";
          if (/[.!?…]["”)]?$/.test(t.w)) { speak(sentence); sentence = ""; }
          void sp.offsetWidth; sp.classList.add("on");
          scrollDown();
          await sleep(pace());
        }
        draining = false;
        if (ended) { if (sentence.trim()) { speak(sentence); sentence = ""; } resolveEnd(); }
      }
      return {
        write(delta) { buf += delta; tokenize(false); },
        end() { ended = true; tokenize(true); if (!draining && !queue.length) resolveEnd(); return done; },
      };
    }
    function beginRebel() {
      const t = el("div", "turn"); const r = el("div", "rebel"); t.appendChild(r); flow.appendChild(t);
      requestAnimationFrame(() => t.classList.add("on")); state("speaking"); scrollDown();
      const w = writer(r);
      return { write: w.write, end: async () => { await w.end(); state("", "here"); return t; } };
    }
    async function rebelSays(lines) { const w = beginRebel(); for (const l of lines) { w.write(l + "\n\n"); await new Promise((r) => setTimeout(r, 0)); } return w.end(); }
    async function reflect(text) { const t = el("div", "turn on"); const rf = el("div", "reflect"); t.appendChild(rf); flow.appendChild(t); state("speaking"); const w = writer(rf, "w", 18); w.write(text); await w.end(); state("", "here"); scrollDown(); }
    function youSaid(text) { const y = el("div", "you", `<span class="lbl">You</span><q>${escape(text)}</q>`); flow.appendChild(y); dimOld(); scrollDown(); }
    function statusLine(lines) {
      const s = el("div", "status"); flow.appendChild(s); state("thinking"); let alive = true;
      (async () => {
        let i = 0;
        while (alive) {
          const p = lines[Math.min(i, lines.length - 1)]; s.innerHTML = "";
          p.split(/(\s+)/).forEach((t) => { if (t) s.appendChild(el("span", "w", escape(t))); });
          for (const w of [...s.children]) { w.classList.add("on"); await sleep(14); }
          await sleep(i < lines.length - 1 ? 700 : 2200); i++;
          if (i >= lines.length && alive) { s.style.transition = "opacity .6s"; s.style.opacity = ".5"; await sleep(800); s.style.opacity = "1"; }
        }
      })();
      return { done() { alive = false; s.remove(); state("", "here"); } };
    }

    // ---------- cards ----------
    function profileCard(profile, o = {}) {
      const rows = [["Idea", profile.idea], ["Goal", profile.goal], ["Time", profile.time], ["Background", profile.background]];
      const n = rows.filter((r) => r[1]).length; const pc = $("#pcount"); if (pc) pc.textContent = `${n} / 4`;
      const extra = [["Fits inside", profile.constraints], ["Noticed", profile.noticed]].filter((r) => r[1]);
      const html = `<div class="eyebrow"><span>What I heard</span><span>${n} of 4 · correct me if I'm off</span></div><div class="rows">${rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${v ? escape(v) : '<span style="color:var(--ash);font-style:italic">not yet</span>'}</span>${v && o.editable ? '<button class="fix">that\'s not quite it</button>' : "<span></span>"}</div>`).join("")}${extra.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span>${escape(v)}</span><span></span></div>`).join("")}</div>`;
      const g = gen(html);
      g.querySelectorAll(".fix").forEach((b) => b.addEventListener("click", () => { const k = b.closest(".row").querySelector(".k").textContent; if (o.onFix) o.onFix(k); }));
      return g;
    }
    function fieldCard(reading) {
      const n = reading.companies.length;
      return gen(`<div class="eyebrow"><span>The field · ${escape(reading.source || "model knowledge")}</span><span>${n} compan${n === 1 ? "y" : "ies"} · what the world model sees</span></div><h4>${escape(reading.title)}</h4><p class="sub">${escape(reading.sub)}</p>${mapSVG(reading.companies, reading.axes)}${reading.caveat ? `<p class="sub" style="margin:10px 0 0;font-size:12px;color:var(--ash)">${escape(reading.caveat)}</p>` : ""}`);
    }
    const KIND = { founder: "founder", eng: "eng", sales: "sales", ops: "ops" };
    function teamsCard(reading) {
      const cos = [...reading.companies].sort((a, b) => (b.highlight - a.highlight) || (b.size - a.size)).slice(0, 5);
      const tok = (t) => `<span class="tok ${t.kind === "founder" ? "f" : t.kind === "eng" ? "e" : t.kind === "ops" ? "o" : "s"}"><i></i>${t.kind === "founder" && t.n <= 1 ? "founder" : `${t.n} ${KIND[t.kind] || t.kind}`}</span>`;
      return gen(`<div class="eyebrow"><span>Who is building this</span><span>Teams · Rebel's best reading</span></div><div class="roster">${cos.map((c, i) => `<div class="co ${c.highlight ? "hi" : ""}" style="animation-delay:${0.15 + i * 0.09}s"><div class="n">${escape(c.name)}</div>${(c.team || []).map(tok).join("") || '<span class="tok"><i></i>unknown</span>'}</div>`).join("")}<div class="kit"><em>${escape(reading.teamsTakeaway || "")}</em></div></div>`);
    }
    function positionsCard(options, axes, companies, onChoose) {
      const pick = options.find((o) => o.pick) || options[0];
      const d = gen(`<div class="eyebrow"><span>Where do you start? Your call.</span><span>hover to see it on the map · tap to choose · <b style="color:var(--ember)">Rebel's pick is marked</b></span></div><div class="dgrid"><div class="dmap">${mapSVG(companies, axes, pick.you)}</div><div class="dopts">${options.map((o) => `<button class="dopt" data-id="${escape(o.id)}"><span class="radio"></span><span><h3><span>${escape(o.title)}</span>${o.pick ? '<span class="pick">Rebel\'s pick</span>' : ""}</h3><p>${escape(o.case)}</p><div class="figs">${(o.figures || []).slice(0, 2).map(figure).join("")}</div></span></button>`).join("")}</div></div>`);
      const svg = d.querySelector("svg"); let chosen = null;
      const moveYou = (o) => { const g = svg.querySelector(".you"); if (!g || !o.you) return; const x = mx(o.you.x), y = my(o.you.y); g.querySelectorAll("circle").forEach((c) => { c.setAttribute("cx", x); c.setAttribute("cy", y); }); const t = g.querySelector("text"); t.setAttribute("x", x + 14); t.setAttribute("y", y + 4); t.textContent = o.you.label; };
      d.querySelectorAll(".dopt").forEach((b) => {
        const o = options.find((x) => x.id === b.dataset.id);
        b.addEventListener("mouseenter", () => { if (!chosen) moveYou(o); });
        b.addEventListener("mouseleave", () => { if (!chosen) moveYou(pick); });
        b.addEventListener("click", () => { if (chosen) return; chosen = o; moveYou(o); d.querySelectorAll(".dopt").forEach((x) => x.classList.toggle("chosen", x === b)); if (onChoose) onChoose(o); });
      });
      setTimeout(() => scroller.scrollTo({ top: d.offsetTop - 12, behavior: "smooth" }), 350);
      return { el: d, choose(id) { const b = d.querySelector(`.dopt[data-id="${CSS.escape(id)}"]`); if (b) b.click(); } };
    }
    function artifactCard(art) {
      const col = (k, xs) => `<div><div class="k">${k}</div><ul>${(xs || []).map((x) => `<li>${escape(x)}</li>`).join("")}</ul></div>`;
      return gen(`<div class="artifact"><div class="eyebrow"><span>Positioning · chosen against the field</span><span>Mutiny · Rebel</span></div><h3>${escape(art.headline)}</h3><div class="grid">${col("Strengths", art.strengths)}${col("Weaknesses", art.weaknesses)}${col("Opportunities", art.opportunities)}</div></div>`);
    }
    function finishCard(o = {}) {
      const g = gen(`<div class="eyebrow"><span>Ready when you are</span><span>one subscription · one living business</span></div><h4>Start the company.</h4><p class="sub">Rebel comes with you. Nothing irreversible happens in there without your press.</p><form class="startco" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px"><input type="email" required placeholder="Your email" autocomplete="email" style="flex:1;min-width:200px;font:inherit;font-size:15px;padding:11px 14px;border:1px solid var(--rule2);border-radius:999px;background:#fff;color:var(--ink);outline:none"><button type="submit" style="background:var(--ember);color:#fff;border:0;border-radius:999px;padding:12px 20px;font:inherit;font-weight:500;cursor:pointer">Start the company →</button><span class="small" style="color:var(--ash);font-size:13px;flex-basis:100%">You'll hear from Mutiny. Nobody else will.</span></form>`);
      const form = g.querySelector("form"), input = form.querySelector("input"), btn = form.querySelector("button");
      if (o.email) { input.value = o.email; }
      form.addEventListener("submit", async (e) => {
        e.preventDefault(); const v = input.value.trim(); if (!v) { input.focus(); return; }
        btn.disabled = true; btn.textContent = "Saving…";
        try { if (o.onEmail) await o.onEmail(v); form.innerHTML = `<span style="font-size:15px">You're in line, ${escape(v)}. Founders are admitted in order of arrival.</span>`; }
        catch (err) { btn.disabled = false; btn.textContent = "Start the company →"; const m = el("span", "small", escape(err.message || "That didn't save. Try again.")); m.style.cssText = "color:var(--ember);font-size:13px;flex-basis:100%"; form.appendChild(m); }
      });
      return g;
    }

    // ---------- answering ----------
    function chips(list, onPick) {
      const c = $("#chips"); c.innerHTML = "";
      (list || []).forEach((ch) => { const b = el("button", "chip" + (ch.ghost ? " ghost" : ""), escape(ch.label)); b.addEventListener("click", () => { c.innerHTML = ""; onPick(ch.label, ch); }); c.appendChild(b); });
      if (list && list.length) { state("listening"); if (S.follow) $("#text").focus({ preventScroll: true }); }
    }
    function clearChips() { $("#chips").innerHTML = ""; }
    function submitText() { const inp = $("#text"); const v = inp.value.trim(); if (!v || !onSendFn) return; inp.value = ""; clearChips(); onSendFn(v); }
    $("#send")?.addEventListener("click", submitText);
    $("#text")?.addEventListener("keydown", (e) => { if (e.key === "Enter") submitText(); });
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; let rec = null;
    if (SR) { rec = new SR(); rec.lang = "en-US"; rec.interimResults = true; rec.onresult = (e) => { let s = ""; for (const r of e.results) s += r[0].transcript; $("#text").value = s; if (e.results[e.results.length - 1].isFinal) { $("#mic").classList.remove("live"); submitText(); } }; rec.onend = () => $("#mic").classList.remove("live"); rec.onerror = () => $("#mic").classList.remove("live"); }
    $("#mic")?.addEventListener("click", () => { if (!rec) { hint("No speech recognition in this browser. Type it, or tap a choice."); return; } if ($("#mic").classList.contains("live")) { rec.stop(); return; } $("#mic").classList.add("live"); state("listening"); try { rec.start(); } catch (e) {} });
    function hint(l, r) { if (l != null && $("#hintl")) $("#hintl").textContent = l; if (r != null && $("#hintr")) $("#hintr").textContent = r; }
    function setInput(enabled) { const a = $("#answer"); if (a) a.classList.toggle("done", !enabled); }
    function onSend(fn) { onSendFn = fn; }
    function clear() { flow.innerHTML = ""; clearChips(); const pc = $("#pcount"); if (pc) pc.textContent = "0 / 4"; if (hasSynth) speechSynthesis.cancel(); }
    root.addEventListener("click", () => { S.follow = true; }, { once: true });

    return { state, speak, scrollDown, dimOld, gen, beginRebel, rebelSays, reflect, youSaid, statusLine, profileCard, fieldCard, teamsCard, positionsCard, artifactCard, finishCard, chips, clearChips, hint, setInput, onSend, clear, mapSVG, escape, S };
  }

  window.IntakeUI = { mount, mapSVG, escape };
})();
