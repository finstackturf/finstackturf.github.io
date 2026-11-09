(() => {
  "use strict";
  const APP_VERSION = "4.2";
  const cfg = window.FINSTACK_CONFIG || {};
  const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE");
  const $ = (id) => document.getElementById(id);
  const APP_URL = (cfg.APP_URL && !cfg.APP_URL.includes("YOUR-")) ? cfg.APP_URL : location.href.split("#")[0].split("?")[0];
  // Supabase puts "type=magiclink|invite|recovery" in the URL when someone arrives from an email link.
  const linkParams = new URLSearchParams((location.hash.startsWith("#") ? location.hash.slice(1) : "") + "&" + location.search.slice(1));
  const arrivedVia = linkParams.get("type");
  const linkError = linkParams.get("error_description");
  const linkPage = new URLSearchParams(location.search).get("page");
  const PAGES = ["overview", "members", "wallet", "deposits", "matches", "live", "chat", "stats", "reports"];

  // ---------------------------------------------------------------- state
  let db, user, profile;
  let members = [], transactions = [], matches = [], requests = [], votes = [], notifications = [];
  let teams = [], innings = [], balls = [], messages = [];
  let realtimeChannel = null, refreshTimer = null, installPrompt = null, countdownTimer = null;
  let currentPage = PAGES.includes(linkPage) ? linkPage : "overview";
  let matchFilter = "upcoming", teamDraft = null, scorerSel = {}, lbMode = "runs", statsFor = null;
  try { scorerSel = JSON.parse(localStorage.getItem("ft_scorer") || "{}"); } catch (_) {}
  const saveScorer = () => { try { localStorage.setItem("ft_scorer", JSON.stringify(scorerSel)); } catch (_) {} }; // scorerSel[matchId] = {batter, bowler, wicketType, outPlayer, nbRuns, byeRuns}

  // -------------------------------------------------------------- helpers
  const money = n => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(Number(n || 0));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const dateFmt = s => s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";
  const dateShort = s => s ? new Date(s + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" }) : "—";
  const dtFmt = s => s ? new Date(s).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
  const timeFmt = t => t ? new Date("2000-01-01T" + t).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) : "";
  const todayIso = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const nameOf = id => members.find(m => m.id === id)?.full_name || "Member";
  const avatarOf = id => members.find(m => m.id === id)?.avatar_url || null;
  const avHtml = (id, cls = "avatar") => { const u = avatarOf(id); const n = nameOf(id); return `<span class="${cls}">${u ? `<img src="${esc(u)}" alt="">` : esc(n.trim()[0] || "P").toUpperCase()}</span>`; };
  const roleLabel = r => ({ batter: "Batter", bowler: "Bowler", "all-rounder": "All-rounder", keeper: "Wicket-keeper" }[r] || "");
  const shortName = id => { const n = nameOf(id).split(" "); return n.length > 1 ? n[0] + " " + n[1][0] + "." : n[0]; };
  const methodLabel = m => ({ upi: "UPI", cash: "Cash", bank: "Bank", other: "Other" }[m] || m);
  const oversFmt = b => `${Math.floor((b || 0) / 6)}.${(b || 0) % 6}`;
  const rr = (runs, b) => b ? (runs / (b / 6)).toFixed(2) : "0.00";
  function toast(msg, error = false) { const t = $("toast"); t.textContent = msg; t.className = "toast show" + (error ? " error" : ""); clearTimeout(toast.timer); toast.timer = setTimeout(() => t.className = "toast", 4200); }
  function fail(e) { console.error(e); toast(e?.message || "Something went wrong. Please try again.", true); }
  function isAdmin() { return profile?.role === "admin" && profile?.approved === true && profile?.active !== false; }
  function balanceFor(id) { return transactions.filter(x => x.profile_id === id).reduce((a, x) => a + Number(x.amount), 0); }
  function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
  function busy(form, on) { form.querySelectorAll("button[type=submit]").forEach(b => b.disabled = on); }
  function confirmDialog(title, text, okLabel = "Yes, continue") {
    return new Promise(resolve => {
      $("confirmTitle").textContent = title; $("confirmText").textContent = text; $("confirmOk").textContent = okLabel;
      const dlg = $("confirmDialog"); const form = $("confirmForm");
      const onSubmit = e => { e.preventDefault(); cleanup(); dlg.close(); resolve(true); };
      const onClose = () => { cleanup(); resolve(false); };
      const cleanup = () => { form.removeEventListener("submit", onSubmit); dlg.removeEventListener("close", onClose); };
      form.addEventListener("submit", onSubmit); dlg.addEventListener("close", onClose); dlg.showModal();
    });
  }
  const activeMembers = () => members.filter(m => m.approved && m.active !== false);
  const canScore = m => isAdmin();
  const canPick = m => isAdmin() || (profile && [m.captain_a, m.captain_b].includes(profile.id));
  const stageOf = m => m.play_status === "completed" ? "done" : m.play_status === "live" ? "live" : m.status === "voting" ? "voting" : "locked";
  const teamOf = m => ({ A: teams.filter(t => t.match_id === m.id && t.team === "A").map(t => t.profile_id), B: teams.filter(t => t.match_id === m.id && t.team === "B").map(t => t.profile_id) });
  const inningsOf = m => innings.filter(i => i.match_id === m.id).sort((a, b) => a.innings_no - b.innings_no);
  const ballsOf = (m, no) => balls.filter(b => b.match_id === m.id && b.innings_no === no).sort((a, b) => a.seq - b.seq);
  const tname = (m, t) => t === "A" ? m.team_a_name || "Team A" : t === "B" ? m.team_b_name || "Team B" : "Tie";
  const matchLabel = m => `${m.venue} · ${dateShort(m.match_date)}${m.start_time ? " · " + timeFmt(m.start_time) : ""}`;
  function playerStats(m, no) {
    const bs = ballsOf(m, no); const bat = {}, bowl = {};
    bs.forEach(b => {
      if (b.batter_id) { const s = bat[b.batter_id] ||= { runs: 0, balls: 0, fours: 0, sixes: 0, out: null }; if (!(b.extra_type === "wd")) s.balls++; if (!b.extra_type || b.extra_type === "nb") { s.runs += b.runs; if (b.runs === 4) s.fours++; if (b.runs === 6) s.sixes++; } }
      if (b.is_wicket && b.out_player_id) { (bat[b.out_player_id] ||= { runs: 0, balls: 0, fours: 0, sixes: 0, out: null }).out = b.wicket_type || "out"; }
      if (b.bowler_id) { const s = bowl[b.bowler_id] ||= { balls: 0, runs: 0, wkts: 0 }; if (b.legal) s.balls++; s.runs += (b.extra_type === "b" || b.extra_type === "lb") ? 0 : b.runs + b.extra_runs; if (b.is_wicket && !/run/i.test(b.wicket_type || "")) s.wkts++; }
    });
    return { bat, bowl, balls: bs };
  }

  // ------------------------------------------------------------- auth/app
  function showAuth() { $("authView").classList.remove("hidden"); $("appView").classList.add("hidden"); }
  function showApp() {
    $("authView").classList.add("hidden"); $("appView").classList.remove("hidden");
    document.querySelectorAll(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin()));
    document.querySelectorAll(".member-only").forEach(el => el.classList.toggle("hidden", isAdmin()));
  }
  async function getProfile() {
    let { data, error } = await db.from("profiles").select("*").eq("user_id", user.id).maybeSingle();
    if (error) throw error;
    if (!data) {
      const link = await db.rpc("link_my_profile"); if (link.error) throw link.error;
      ({ data, error } = await db.from("profiles").select("*").eq("user_id", user.id).maybeSingle()); if (error) throw error;
    }
    profile = data;
    if (!profile) { await db.auth.signOut(); showAuth(); toast("No member record found for this login. Ask the admin to add your email, then sign in again."); return false; }
    if (!profile.approved) { await db.auth.signOut(); showAuth(); toast("Your account is awaiting admin approval."); return false; }
    if (profile.active === false) { await db.auth.signOut(); showAuth(); toast("Your account has been marked inactive. Contact the admin."); return false; }
    return true;
  }
  async function refreshAll() {
    const [m, t, ma, r, v, n, tm, inn, bl, msg] = await Promise.all([
      db.from("profiles").select("id,user_id,full_name,email,phone,role,approved,active,created_at,avatar_url,playing_role,bio").order("full_name"),
      db.from("wallet_transactions").select("id,profile_id,amount,transaction_type,description,match_id,created_at").order("created_at", { ascending: false }).limit(1000),
      db.from("matches").select("*,match_attendance(profile_id,share_amount)").order("match_date", { ascending: false }).order("created_at", { ascending: false }).limit(200),
      db.from("deposit_requests").select("id,profile_id,amount,method,reference,note,status,created_at,reviewed_by,reviewed_at,review_note").order("created_at", { ascending: false }).limit(300),
      db.from("match_votes").select("match_id,profile_id,vote,comment,updated_at"),
      db.from("notifications").select("id,kind,title,body,match_id,read,created_at").order("created_at", { ascending: false }).limit(100),
      db.from("match_teams").select("match_id,profile_id,team"),
      db.from("match_innings").select("*"),
      db.from("match_balls").select("*").order("created_at", { ascending: false }).limit(10000),
      db.from("messages").select("id,profile_id,match_id,kind,body,created_at").order("created_at", { ascending: false }).limit(400)
    ]);
    for (const x of [m, t, ma, r]) if (x.error) throw x.error;
    members = m.data || []; transactions = t.data || []; matches = ma.data || []; requests = r.data || [];
    const me = members.find(x => x.id === profile?.id); if (me) profile = me;
    votes = v.error ? [] : (v.data || []); notifications = n.error ? [] : (n.data || []);
    teams = tm.error ? [] : (tm.data || []); innings = inn.error ? [] : (inn.data || []); balls = bl.error ? [] : (bl.data || []); messages = msg.error ? [] : (msg.data || []).reverse();
    if (v.error || n.error) console.warn("v3 tables missing? Run database/upgrade-v3.sql", v.error || n.error);
    if (tm.error || inn.error || bl.error || msg.error) console.warn("v6 tables missing? Run database/upgrade-v6-stadium.sql", tm.error || inn.error || bl.error || msg.error);
    renderAll();
  }

  // --------------------------------------------------------------- render
  function renderAll() { renderHeader(); renderBell(); renderOverview(); renderMembers(); renderWallet(); renderDeposits(); renderMatches(); renderLive(); renderChat(); renderStats(); renderReports(); renderCentre(); }
  function voteInfo(m) {
    const vs = votes.filter(v => v.match_id === m.id);
    const yes = vs.filter(v => v.vote === "yes").map(v => v.profile_id), no = vs.filter(v => v.vote === "no").map(v => v.profile_id);
    const pending = activeMembers().map(x => x.id).filter(id => !yes.includes(id) && !no.includes(id));
    const mine = vs.find(v => v.profile_id === profile.id)?.vote || null;
    return { yes, no, pending, mine, est: yes.length ? Number(m.total_cost) / yes.length : null };
  }
  const myOpenVotes = () => matches.filter(m => m.status === "voting" && !voteInfo(m).mine);
  const liveMatches = () => matches.filter(m => m.play_status === "live");
  const chatUnread = () => { let last = 0; try { last = Number(localStorage.getItem("ft_chat_read_" + profile.id) || 0); } catch (_) {} return messages.filter(x => !x.match_id && x.profile_id !== profile.id && new Date(x.created_at).getTime() > last).length; };
  function renderBell() {
    const unread = notifications.filter(n => !n.read).length;
    $("bellBadge").textContent = unread > 99 ? "99+" : unread; $("bellBadge").classList.toggle("hidden", !unread);
    const icons = { vote: "🗳", match: "🏏", wallet: "₹", deposit: "↧", admin: "★", activity: "👥", info: "•" };
    $("notifList").innerHTML = notifications.length ? notifications.slice(0, 40).map(n => `<button class="notif ${n.read ? "" : "unread"}" data-notif="${n.id}"><span class="notif-icon">${icons[n.kind] || "•"}</span><span><b>${esc(n.title)}</b><small>${esc(n.body || "")}</small><em>${dtFmt(n.created_at)}</em></span></button>`).join("") : '<div class="empty">No notifications yet.</div>';
    renderAlertsState();
  }
  function renderHeader() {
    $("topUserName").textContent = profile.full_name || user.email; $("topUserRole").textContent = isAdmin() ? "ADMIN" : "MEMBER";
    $("topAvatar").innerHTML = profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="">` : esc((profile.full_name || user.email || "P").trim()[0].toUpperCase());
    $("todayLabel").textContent = new Date().toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const pending = requests.filter(r => r.status === "pending" && (isAdmin() || r.profile_id === profile.id)).length;
    $("navDepositBadge").textContent = pending; $("navDepositBadge").classList.toggle("hidden", !pending);
    const ov = myOpenVotes().length; $("navVoteBadge").textContent = ov; $("navVoteBadge").classList.toggle("hidden", !ov);
    $("navLiveBadge").classList.toggle("hidden", !liveMatches().length);
    const cu = chatUnread(); $("navChatBadge").textContent = cu; $("navChatBadge").classList.toggle("hidden", !cu);
  }
  function txRows(rows, showMember) {
    if (!rows.length) return '<div class="empty">No wallet activity yet.</div>';
    const typeLabel = { deposit: "Deposit", match_deduction: "Match", credit: "Credit", debit: "Debit" };
    return `<table><thead><tr><th>DATE</th><th>DETAIL</th><th>TYPE</th><th>AMOUNT</th></tr></thead><tbody>${rows.map(t =>
      `<tr><td>${dtFmt(t.created_at)}</td><td>${esc(t.description || "Wallet transaction")}${showMember ? `<small class="muted"> · ${esc(nameOf(t.profile_id))}</small>` : ""}</td><td><span class="status tx-${esc(t.transaction_type)}">${typeLabel[t.transaction_type] || esc(t.transaction_type)}</span></td><td class="${Number(t.amount) >= 0 ? "amount-positive" : "amount-negative"}">${Number(t.amount) >= 0 ? "+" : ""}${money(t.amount)}</td></tr>`
    ).join("")}</tbody></table>`;
  }
  function scoreLine(m, no) { const i = inningsOf(m).find(x => x.innings_no === no); return i ? `${i.runs}/${i.wickets} <small>(${oversFmt(i.balls)} ov)</small>` : "—"; }
  function teamScore(m, t) { const i = inningsOf(m).find(x => x.batting_team === t); return i && (i.status !== "pending" || i.balls || i.runs) ? `${i.runs}/${i.wickets}` : "—"; }
  function teamOvers(m, t) { const i = inningsOf(m).find(x => x.batting_team === t); return i && (i.status !== "pending" || i.balls) ? `${oversFmt(i.balls)} ov` : "yet to bat"; }
  function renderOverview() {
    $("myBalance").textContent = money(balanceFor(profile.id)); $("walletBalance").textContent = money(balanceFor(profile.id));
    $("myMatches").textContent = matches.filter(m => (m.match_attendance || []).some(a => a.profile_id === profile.id)).length;
    $("mySpend").textContent = money(-transactions.filter(t => t.profile_id === profile.id && t.transaction_type === "match_deduction").reduce((a, t) => a + Number(t.amount), 0));
    $("myPendingDeposits").textContent = requests.filter(r => r.profile_id === profile.id && r.status === "pending").length;
    const open = myOpenVotes(); $("myVotesNeeded").textContent = open.length;
    $("votePanel").classList.toggle("hidden", !open.length);
    $("voteList").innerHTML = open.map(m => { const vi = voteInfo(m); return `<div class="vote-item"><div><b>${esc(m.venue)}</b><small>${dateShort(m.match_date)}${m.start_time ? " · " + timeFmt(m.start_time) : ""} · ${money(m.total_cost)} total · ${vi.yes.length} in so far${vi.est ? " · ~" + money(vi.est) + " each" : ""}</small></div><div class="btn-row"><button class="btn primary sm" data-vote="${m.id}" data-vote-value="yes">I'm in</button><button class="btn ghost sm" data-vote="${m.id}" data-vote-value="no">Can't make it</button></div></div>`; }).join("");
    if (isAdmin()) {
      $("clubBalance").textContent = money(members.filter(m => m.approved).reduce((a, m) => a + balanceFor(m.id), 0));
      const p = requests.filter(r => r.status === "pending");
      $("pendingDeposits").textContent = p.length;
      $("pendingDepositsHint").textContent = p.length ? `${money(p.reduce((a, r) => a + Number(r.amount), 0))} waiting for your review` : "No requests waiting";
    }
    // live strip
    const lv = liveMatches()[0];
    $("liveStrip").classList.toggle("hidden", !lv);
    if (lv) { const bat = inningsOf(lv).find(i => i.status === "live") || inningsOf(lv)[0]; $("liveStrip").innerHTML = `<div><div class="lbl">🔴 LIVE · ${esc(lv.venue)}</div><div class="sc">${esc(tname(lv, "A"))} ${teamScore(lv, "A")} <span class="muted">vs</span> ${esc(tname(lv, "B"))} ${teamScore(lv, "B")}</div></div><div class="btn-row"><span class="muted">${bat ? esc(tname(lv, bat.batting_team)) + " batting · " + oversFmt(bat.balls) + " ov" : ""}</span><button class="btn primary sm" data-goto="live">Scoreboard →</button></div>`; }
    // next fixture
    const today = todayIso();
    const next = [...matches].filter(m => m.play_status !== "completed" && m.match_date >= today).sort((a, b) => a.match_date.localeCompare(b.match_date) || (a.start_time || "").localeCompare(b.start_time || ""))[0];
    $("nextFixture").classList.toggle("hidden", !next);
    if (next) {
      const vi = next.status === "voting" ? voteInfo(next) : null; const att = (next.match_attendance || []).length;
      $("nextFixture").innerHTML = `<div class="nf-grid"><div><span class="eyebrow">NEXT FIXTURE · ${stageOf(next) === "voting" ? "VOTING OPEN" : stageOf(next) === "live" ? "LIVE NOW" : "TEAM LOCKED"}</span><div class="nf-title">${esc(next.venue)}</div><div class="nf-meta"><span>📅 <b>${dateShort(next.match_date)}</b></span>${next.start_time ? `<span>⏰ <b>${timeFmt(next.start_time)}</b></span>` : ""}${next.venue_url ? `<span>📍 <a href="${esc(next.venue_url)}" target="_blank" rel="noopener">Open map ↗</a></span>` : ""}${next.end_time ? `<span>🏁 <b>${timeFmt(next.end_time)}</b></span>` : ""}${next.overs ? `<span>🏏 <b>${next.overs}</b> overs</span>` : ""}<span>${vi ? `<b>${vi.yes.length}</b> in · ${vi.pending.length} to vote` : `<b>${att}</b> players`}</span></div><div class="captain-row">${next.captain_a ? `<span>©️ ${esc(tname(next, "A"))}: <b>${esc(nameOf(next.captain_a))}</b></span>` : ""}${next.captain_b ? `<span>©️ ${esc(tname(next, "B"))}: <b>${esc(nameOf(next.captain_b))}</b></span>` : ""}</div><div class="btn-row" style="margin-top:12px"><button class="btn primary sm" data-open-match="${next.id}">Match centre →</button>${vi && !vi.mine ? `<button class="btn ghost sm" data-goto="matches">Vote now</button>` : ""}</div></div><div class="countdown" id="countdown" data-when="${next.match_date}T${next.start_time || "00:00:00"}"></div></div>`;
      tickCountdown();
    }
    $("overviewTransactions").innerHTML = txRows(transactions.filter(t => isAdmin() || t.profile_id === profile.id).slice(0, 6), isAdmin());
    const list = matches.slice(0, 5);
    $("overviewMatches").innerHTML = list.length ? list.map(m => {
      const mine = (m.match_attendance || []).find(a => a.profile_id === profile.id); const st = stageOf(m);
      const sub = st === "voting" ? voteInfo(m).yes.length + " in · voting open" : st === "live" ? "🔴 live" : st === "done" ? esc(m.result_text || "completed") : (m.match_attendance || []).length + " players · " + (m.status === "settled" ? "settled" : "team locked");
      return `<div class="mini-item" data-open-match="${m.id}" style="cursor:pointer"><div><b>${esc(m.venue)}</b><small>${dateShort(m.match_date)} · ${sub}</small></div><strong>${st === "done" || st === "live" ? `${teamScore(m, "A")} <small>v</small> ${teamScore(m, "B")}` : mine ? money(mine.share_amount) + "<small> my share</small>" : money(m.total_cost)}</strong></div>`;
    }).join("") : '<div class="empty">No matches recorded yet.</div>';
  }
  function tickCountdown() {
    const el = $("countdown"); if (!el) return;
    const when = new Date(el.dataset.when).getTime(); const diff = when - Date.now();
    if (isNaN(when)) { el.innerHTML = ""; return; }
    if (diff <= 0) { el.innerHTML = `<div class="cd"><b>GO</b><span>MATCH DAY</span></div>`; return; }
    const d = Math.floor(diff / 864e5), h = Math.floor(diff % 864e5 / 36e5), mi = Math.floor(diff % 36e5 / 6e4);
    el.innerHTML = `<div class="cd"><b>${d}</b><span>DAYS</span></div><div class="cd"><b>${h}</b><span>HRS</span></div><div class="cd"><b>${mi}</b><span>MIN</span></div>`;
  }
  function renderMembers() {
    if (!isAdmin()) return;
    const approved = members.filter(m => m.approved && m.active !== false);
    $("approvedCount").textContent = approved.length; $("pendingCount").textContent = members.filter(m => !m.approved).length;
    $("membersBalance").textContent = money(members.filter(m => m.approved).reduce((a, m) => a + balanceFor(m.id), 0));
    const showInactive = $("showInactive").checked;
    const rows = members.filter(m => showInactive || m.active !== false);
    $("membersTable").innerHTML = rows.length ? `<table><thead><tr><th>MEMBER</th><th>CONTACT</th><th>ROLE</th><th>STATUS</th><th>LOGIN</th><th>BALANCE</th><th>ACTIONS</th></tr></thead><tbody>${rows.map(m => {
      const status = m.active === false ? '<span class="status inactive">INACTIVE</span>' : m.approved ? '<span class="status">ACTIVE</span>' : '<span class="status pending">PENDING</span>';
      const login = m.user_id ? '<span class="status">LINKED</span>' : m.email ? '<span class="status pending">INVITED</span>' : '<span class="muted">No email</span>';
      const actions = `<button class="btn ghost sm manage-btn" data-manage="${m.id}">Manage ⋯</button>`;
      return `<tr><td>${avHtml(m.id, "msg-av")}<b>${esc(m.full_name)}</b>${m.playing_role ? `<small class="muted"> · ${roleLabel(m.playing_role)}</small>` : ""}</td><td>${esc(m.email || "—")}${m.phone ? `<small class="muted"> · ${esc(m.phone)}</small>` : ""}</td><td>${esc(m.role)}</td><td>${status}</td><td>${login}</td><td>${money(balanceFor(m.id))}</td><td class="actions">${actions}</td></tr>`;
    }).join("")}</tbody></table>` : '<div class="empty">No members yet. Click “Add member” to add your squad.</div>';
    $("depositMember").innerHTML = approved.map(m => `<option value="${m.id}">${esc(m.full_name)}</option>`).join("");
    const f = $("walletFilter"); const cur = f.value;
    f.innerHTML = '<option value="">All members</option>' + members.filter(m => m.approved).map(m => `<option value="${m.id}">${esc(m.full_name)}</option>`).join("");
    f.value = cur;
  }
  function renderWallet() {
    if (isAdmin()) {
      const sel = $("walletFilter").value;
      $("walletTitle").textContent = sel ? `${nameOf(sel)} — ${money(balanceFor(sel))}` : "Club ledger (all members)";
      $("walletTable").innerHTML = txRows(transactions.filter(t => !sel || t.profile_id === sel), !sel);
    } else {
      $("walletTitle").textContent = "Wallet transactions";
      $("walletTable").innerHTML = txRows(transactions.filter(t => t.profile_id === profile.id), false);
    }
  }
  function reqStatus(s) { return `<span class="status ${s === "approved" ? "" : s === "pending" ? "pending" : "inactive"}">${s.toUpperCase()}</span>`; }
  function renderDeposits() {
    const mine = requests.filter(r => r.profile_id === profile.id);
    if (isAdmin()) {
      const pending = requests.filter(r => r.status === "pending");
      $("depositsTitle").textContent = "Deposit requests"; $("depositsHint").textContent = "Members record what they paid you; approve to credit their wallet, or reject with a note.";
      $("pendingPanelCount").textContent = `${pending.length} PENDING`;
      $("pendingTable").innerHTML = pending.length ? `<table><thead><tr><th>WHEN</th><th>MEMBER</th><th>AMOUNT</th><th>VIA</th><th>REFERENCE / NOTE</th><th></th></tr></thead><tbody>${pending.map(r =>
        `<tr><td>${dtFmt(r.created_at)}</td><td><b>${esc(nameOf(r.profile_id))}</b></td><td class="amount-positive">${money(r.amount)}</td><td>${methodLabel(r.method)}</td><td>${esc(r.reference || "—")}${r.note ? `<small class="muted"> · ${esc(r.note)}</small>` : ""}</td><td><button class="btn primary sm" data-review="${r.id}">Review</button></td></tr>`
      ).join("")}</tbody></table>` : '<div class="empty">No pending requests. 🎉</div>';
      const history = requests.filter(r => r.status !== "pending");
      $("historyTitle").textContent = "Reviewed requests";
      $("historyTable").innerHTML = history.length ? `<table><thead><tr><th>WHEN</th><th>MEMBER</th><th>AMOUNT</th><th>VIA</th><th>STATUS</th><th>REVIEWED</th></tr></thead><tbody>${history.map(r =>
        `<tr><td>${dtFmt(r.created_at)}</td><td>${esc(nameOf(r.profile_id))}</td><td>${money(r.amount)}</td><td>${methodLabel(r.method)}</td><td>${reqStatus(r.status)}</td><td>${dtFmt(r.reviewed_at)}${r.review_note ? `<small class="muted"> · ${esc(r.review_note)}</small>` : ""}</td></tr>`
      ).join("")}</tbody></table>` : '<div class="empty">Nothing reviewed yet.</div>';
    } else {
      $("depositsTitle").textContent = "My deposits"; $("depositsHint").textContent = "Paid the admin via UPI or cash? Record it here and it will be credited once the admin confirms.";
      $("historyTitle").textContent = "My deposit requests";
      $("historyTable").innerHTML = mine.length ? `<table><thead><tr><th>WHEN</th><th>AMOUNT</th><th>VIA</th><th>REFERENCE</th><th>STATUS</th><th></th></tr></thead><tbody>${mine.map(r =>
        `<tr><td>${dtFmt(r.created_at)}</td><td>${money(r.amount)}</td><td>${methodLabel(r.method)}</td><td>${esc(r.reference || "—")}</td><td>${reqStatus(r.status)}${r.review_note ? `<small class="muted"> · ${esc(r.review_note)}</small>` : ""}</td><td>${r.status === "pending" ? `<button class="text-btn danger" data-cancel-request="${r.id}">Cancel</button>` : ""}</td></tr>`
      ).join("")}</tbody></table>` : '<div class="empty">You have not submitted any deposit requests yet.</div>';
    }
  }
  function matchDetailsLine(m) {
    return `<div class="match-meta">📅 ${dateShort(m.match_date)}${m.start_time ? ` · ⏰ ${timeFmt(m.start_time)}${m.end_time ? " – " + timeFmt(m.end_time) : ""}` : ""}${m.overs ? ` · 🏏 ${m.overs} overs` : ""}${m.venue_url ? ` · <a href="${esc(m.venue_url)}" target="_blank" rel="noopener">📍 Map ↗</a>` : ""}${m.notes ? " · " + esc(m.notes) : ""}</div>` +
      ((m.captain_a || m.captain_b) ? `<div class="captain-row">${m.captain_a ? `<span>©️ ${esc(tname(m, "A"))}: <b>${esc(nameOf(m.captain_a))}</b></span>` : ""}${m.captain_b ? `<span>©️ ${esc(tname(m, "B"))}: <b>${esc(nameOf(m.captain_b))}</b></span>` : ""}</div>` : "");
  }
  function resultStrip(m) {
    if (!inningsOf(m).length) return "";
    return `<div class="result-strip"><div class="tm"><b>${esc(tname(m, "A"))}</b><span>${teamScore(m, "A")}</span><small>${teamOvers(m, "A")}</small></div><div class="vs">VS</div><div class="tm b"><b>${esc(tname(m, "B"))}</b><span>${teamScore(m, "B")}</span><small>${teamOvers(m, "B")}</small></div></div>` + (m.result_text ? `<div class="result-text">🏆 ${esc(m.result_text)}${m.mom_profile_id ? ` · ⭐ ${esc(nameOf(m.mom_profile_id))}` : ""}</div>` : "");
  }
  function renderMatches() {
    const list = matches.filter(m => matchFilter === "all" ? true : matchFilter === "history" ? m.play_status === "completed" : m.play_status !== "completed");
    $("matchList").innerHTML = list.length ? list.map(m => {
      const att = m.match_attendance || []; const count = att.length;
      const mine = att.find(a => a.profile_id === profile.id); const st = stageOf(m);
      if (st === "voting") {
        const vi = voteInfo(m);
        const chip = (id, cls) => `<span class="chip ${cls}">${esc(nameOf(id))}</span>`;
        const lists = `<div class="vote-cols"><div><small class="muted">IN (${vi.yes.length})</small><div class="chips">${vi.yes.map(id => chip(id, "yes")).join("") || '<span class="muted">—</span>'}</div></div><div><small class="muted">OUT (${vi.no.length})</small><div class="chips">${vi.no.map(id => chip(id, "no")).join("") || '<span class="muted">—</span>'}</div></div><div><small class="muted">NOT VOTED (${vi.pending.length})</small><div class="chips">${vi.pending.map(id => chip(id, "pending")).join("") || '<span class="muted">—</span>'}</div></div></div>`;
        const myBtns = `<div class="btn-row"><button class="btn ${vi.mine === "yes" ? "primary" : "ghost"} sm" data-vote="${m.id}" data-vote-value="yes">${vi.mine === "yes" ? "✓ I'm in" : "I'm in"}</button><button class="btn ${vi.mine === "no" ? "danger-fill" : "ghost"} sm" data-vote="${m.id}" data-vote-value="no">${vi.mine === "no" ? "✓ Can't make it" : "Can't make it"}</button></div>`;
        const comments = messages.filter(x => x.match_id === m.id).length;
        const adminBtns = isAdmin() ? `<div class="btn-row"><button class="text-btn" data-edit-match="${m.id}">Edit</button><button class="text-btn" data-remind="${m.id}">Remind ${vi.pending.length}</button><button class="text-btn danger" data-delete-match="${m.id}">Delete</button><button class="btn primary sm" data-close-voting="${m.id}">Close voting →</button></div>` : "";
        return `<article class="match-card voting"><div class="match-card-top"><span class="eyebrow">${dateFmt(m.match_date)}</span><span class="status voting">VOTING OPEN</span></div><h3>${esc(m.venue)}</h3>${matchDetailsLine(m)}<div class="match-cost">${money(m.total_cost)}<small class="muted"> total</small></div><div class="match-meta">${vi.est ? "~" + money(vi.est) + " per player if " + vi.yes.length + " play" : "Share depends on how many are in"} · ${vi.yes.length} in · ${vi.pending.length} yet to vote</div>${lists}<div class="vote-comment"><input data-vote-comment="${m.id}" maxlength="200" placeholder="Suggestion? e.g. 8pm works better / other venue / Sunday instead"></div><div class="match-foot vote-foot"><span>${vi.mine ? (vi.mine === "yes" ? "You're in ✓" : "You're out") : "<b>Your vote is needed</b>"}</span>${myBtns}</div><div class="match-foot"><button class="text-btn" data-open-match="${m.id}" data-ctab="chat">💬 ${comments} comment${comments === 1 ? "" : "s"} · Match centre</button>${adminBtns}</div></article>`;
      }
      const names = att.map(a => nameOf(a.profile_id)).sort((a, b) => a.localeCompare(b));
      const tm = teamOf(m); const picked = tm.A.length + tm.B.length;
      const chips = picked ? "" : names.slice(0, 8).map(n => `<span class="chip">${esc(n)}</span>`).join("") + (names.length > 8 ? `<span class="chip more">+${names.length - 8} more</span>` : "");
      const badge = st === "live" ? '<span class="status live">🔴 LIVE</span>' : st === "done" ? '<span class="status done">FULL TIME</span>' : m.status === "settled" ? '<span class="status settled">SETTLED</span>' : '<span class="status unsettled">TEAM LOCKED</span>';
      const playBtns = [
        `<button class="btn ghost sm" data-open-match="${m.id}">${st === "done" ? "Scorecard" : "Match centre"}</button>`,
        st === "live" ? `<button class="btn primary sm" data-goto="live">${canScore(m) ? "Score now 🔴" : "Live score 🔴"}</button>` : "",
        st === "locked" && canPick(m) ? `<button class="btn ghost sm" data-open-match="${m.id}" data-ctab="teams">Pick teams</button>` : "",
        st === "locked" && canScore(m) ? `<button class="btn primary sm" data-start-match="${m.id}">Start match</button>` : ""
      ].join("");
      const adminBtns = isAdmin() ? `<div class="btn-row">${st !== "done" ? `<button class="text-btn" data-edit-match="${m.id}">Edit</button>` : ""}${m.voting_closed_at && st === "locked" && m.status !== "settled" ? `<button class="text-btn" data-reopen-voting="${m.id}">Reopen voting</button>` : ""}${st === "done" ? `<button class="text-btn" data-reopen-match="${m.id}">Reopen result</button>` : ""}${m.status !== "settled" ? `<button class="text-btn danger" data-delete-match="${m.id}">Delete</button><button class="btn primary sm" data-settle="${m.id}">Settle ₹ →</button>` : `<span class="muted">✓ Settled ${dtFmt(m.settled_at)}</span>`}</div>` : (m.status === "settled" ? `<span class="muted">✓ Settled</span>` : "");
      return `<article class="match-card ${st}"><div class="match-card-top"><span class="eyebrow">${dateFmt(m.match_date)}</span>${badge}</div><h3>${esc(m.venue)}</h3>${matchDetailsLine(m)}${resultStrip(m)}${picked ? `<div class="match-meta" style="margin-top:8px">${esc(tname(m, "A"))} (${tm.A.length}) vs ${esc(tname(m, "B"))} (${tm.B.length})${count - picked > 0 ? ` · ${count - picked} unassigned` : ""}</div>` : `<div class="chips">${chips || '<span class="muted">No players selected</span>'}</div>`}<div class="match-cost">${money(m.total_cost)}<small class="muted"> total · ${count ? money(Number(m.total_cost) / count) + " each" : "no players"}</small></div><div class="match-foot"><span>${mine ? `You're playing · <b>${money(mine.share_amount)}</b>` : "You're not in this one"}</span><div class="btn-row">${playBtns}</div></div>${adminBtns ? `<div class="match-admin">${adminBtns}</div>` : ""}</article>`;
    }).join("") : `<div class="empty">${matchFilter === "history" ? "No completed matches yet." : "No matches yet. Admin can create the first match."}</div>`;
  }
  // ---- scoreboard
  function ballChip(b) {
    const cls = b.is_wicket ? "w" : b.extra_type ? "x" : b.runs === 4 ? "four" : b.runs === 6 ? "six" : "";
    const txt = b.is_wicket ? "W" : b.extra_type ? (b.extra_type.toUpperCase() + (b.runs + b.extra_runs > 1 ? b.runs + b.extra_runs : "")) : b.runs;
    return `<span class="ball ${cls}" title="${esc(nameOf(b.batter_id))} · ${esc(nameOf(b.bowler_id))}">${txt}</span>`;
  }
  function statsTables(m, no) {
    const st = playerStats(m, no); const i = inningsOf(m).find(x => x.innings_no === no);
    if (!st.balls.length) return i && (i.runs || i.balls) ? `<p class="hint">Totals entered manually · ${i.runs}/${i.wickets} in ${oversFmt(i.balls)} overs.</p>` : "";
    const bat = Object.entries(st.bat).map(([id, s]) => `<tr><td>${esc(nameOf(id))}</td><td>${s.runs}</td><td>${s.balls}</td><td>${s.fours}</td><td>${s.sixes}</td><td class="muted">${s.out ? esc(s.out) : "not out"}</td></tr>`).join("");
    const bowl = Object.entries(st.bowl).map(([id, s]) => `<tr><td>${esc(nameOf(id))}</td><td>${oversFmt(s.balls)}</td><td>${s.runs}</td><td>${s.wkts}</td><td>${rr(s.runs, s.balls)}</td></tr>`).join("");
    return `<div class="table-wrap"><table class="sc-table"><thead><tr><th>BATTER</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th></th></tr></thead><tbody>${bat || '<tr><td colspan="6" class="muted">No batting recorded</td></tr>'}</tbody></table></div><div class="table-wrap" style="margin-top:8px"><table class="sc-table"><thead><tr><th>BOWLER</th><th>O</th><th>R</th><th>W</th><th>ECON</th></tr></thead><tbody>${bowl || '<tr><td colspan="5" class="muted">No bowling recorded</td></tr>'}</tbody></table></div>${i ? `<p class="hint">Extras ${i.extras} · ${oversFmt(i.balls)} overs</p>` : ""}`;
  }
  function renderLive() {
    const lv = liveMatches();
    $("liveBoards").innerHTML = lv.length ? lv.map(m => {
      const inns = inningsOf(m); const cur = inns.find(i => i.status === "live"); const i1 = inns.find(i => i.innings_no === 1), i2 = inns.find(i => i.innings_no === 2);
      const target = i1 && i1.status === "completed" ? i1.runs + 1 : null;
      const line = cur ? `<div class="board-line"><span>Batting: <b>${esc(tname(m, cur.batting_team))}</b></span><span>Run rate <b>${rr(cur.runs, cur.balls)}</b></span>${target && cur.innings_no === 2 ? `<span>Target <b>${target}</b></span><span>Need <b>${Math.max(target - cur.runs, 0)}</b> off <b>${Math.max(m.overs * 6 - cur.balls, 0)}</b> balls</span>` : `<span>Overs <b>${oversFmt(cur.balls)}/${m.overs}</b></span>`}</div>` : `<div class="board-line"><span>Innings break — ${i1 ? esc(tname(m, i1.batting_team)) + " made " + i1.runs + "/" + i1.wickets : ""}</span></div>`;
      const last = cur ? ballsOf(m, cur.innings_no).slice(-8) : [];
      const bt = t => { const i = inns.find(x => x.batting_team === t); return `<div class="bt ${t === "B" ? "b" : ""} ${cur && cur.batting_team === t ? "batting" : ""}"><b>${esc(tname(m, t))}${(t === "A" ? m.captain_a : m.captain_b) ? ` <small style="display:inline">©️ ${esc(shortName(t === "A" ? m.captain_a : m.captain_b))}</small>` : ""}</b><span class="sc">${i && (i.status !== "pending" || i.balls || i.runs) ? `${i.runs}/${i.wickets}` : "—"}</span><span class="ov">${i && (i.status !== "pending" || i.balls) ? oversFmt(i.balls) : ""}</span><small>${i ? (i.status === "pending" ? "yet to bat" : i.status === "completed" ? "innings over" : "batting") : ""}</small></div>`; };
      const scorer = canScore(m) && cur ? scorerPanel(m, cur) : canScore(m) && !cur ? `<div class="scorer"><div class="row"><button class="btn primary" data-end-match="${m.id}">End match 🏆</button><button class="btn ghost" data-totals="${m.id}" data-innings="2">Edit 2nd innings totals</button></div></div>` : "";
      return `<article class="board"><div class="board-head"><h3>🔴 ${esc(m.venue)} · ${dateShort(m.match_date)}</h3><div class="btn-row"><span class="status live">LIVE</span><button class="btn ghost sm" data-open-match="${m.id}" data-ctab="score">Full scorecard</button></div></div><div class="board-teams">${bt("A")}<div class="board-vs">VS</div>${bt("B")}</div>${line}${last.length ? `<div class="balls">${last.map(ballChip).join("")}</div>` : ""}${cur ? statsTables(m, cur.innings_no) : ""}${scorer}</article>`;
    }).join("") : '<div class="empty">No match is live right now. Captains or the admin can start one from Fixtures once the team sheet is locked.</div>';
  }
  function dismissed(m, no) { return new Set(ballsOf(m, no).filter(b => b.is_wicket && b.out_player_id).map(b => b.out_player_id)); }
  function scorerState(m, cur) {
    const tm = teamOf(m); const att = (m.match_attendance || []).map(a => a.profile_id);
    const batSide = tm[cur.batting_team].length ? tm[cur.batting_team] : att.filter(p => !tm[cur.batting_team === "A" ? "B" : "A"].includes(p));
    const bowlSide = tm[cur.batting_team === "A" ? "B" : "A"].length ? tm[cur.batting_team === "A" ? "B" : "A"] : att.filter(p => !batSide.includes(p));
    const out = dismissed(m, cur.innings_no);
    const available = batSide.filter(p => !out.has(p));
    const key = m.id + ":" + cur.innings_no; const s = scorerSel[key] ||= {};
    if (!available.includes(s.striker)) s.striker = available.find(p => p !== s.nonStriker) || available[0] || null;
    if (!available.includes(s.nonStriker) || s.nonStriker === s.striker) s.nonStriker = available.find(p => p !== s.striker) || null;
    if (!bowlSide.includes(s.bowler)) s.bowler = bowlSide[0] || null;
    return { key, s, batSide, bowlSide, out, available };
  }
  function scorerPanel(m, cur) {
    const { key, s, bowlSide, out, available } = scorerState(m, cur);
    const opt = (ids, sel) => ids.map(id => `<option value="${id}" ${id === sel ? "selected" : ""}>${esc(nameOf(id))}</option>`).join("");
    const bench = [...out].map(id => `<s>${esc(shortName(id))}</s>`).join(", ");
    return `<div class="scorer" data-scorer="${m.id}" data-innings="${cur.innings_no}" data-key="${key}">
      <div class="crease"><span class="pill">🏏 Striker <b>${s.striker ? esc(nameOf(s.striker)) : "—"}</b></span><span class="pill">Non-striker <b>${s.nonStriker ? esc(nameOf(s.nonStriker)) : "—"}</b></span><span class="pill bowl">⚾ Bowler <b>${s.bowler ? esc(nameOf(s.bowler)) : "—"}</b></span></div>
      <div class="row"><label style="margin:0;display:flex;gap:6px;align-items:center;color:#aab8c9">Striker <select data-sel="striker">${opt(available, s.striker)}</select></label><label style="margin:0;display:flex;gap:6px;align-items:center;color:#aab8c9">Non-striker <select data-sel="nonStriker">${opt(available, s.nonStriker)}</select></label><button type="button" class="btn ghost sm" data-swap="${key}">⇄ Swap</button><label style="margin:0;display:flex;gap:6px;align-items:center;color:#aab8c9">Bowler <select data-sel="bowler">${opt(bowlSide, s.bowler)}</select></label></div>
      ${out.size ? `<div class="bench">Bench (out): ${bench}</div>` : ""}
      <div class="runbtns" style="margin-top:10px">${[0, 1, 2, 3].map(r => `<button class="runbtn" data-ball="run" data-runs="${r}">${r}</button>`).join("")}<button class="runbtn four" data-ball="run" data-runs="4">4</button><button class="runbtn six" data-ball="run" data-runs="6">6</button><button class="runbtn x" data-ball="wd">Wd</button><button class="runbtn x" data-ball="nb">Nb</button><button class="runbtn x" data-ball="b">Bye</button><button class="runbtn x" data-ball="lb">LB</button><button class="runbtn w" data-ball="w">W</button></div>
      <div class="row" style="margin-top:10px"><label style="margin:0;display:flex;gap:6px;align-items:center;color:#aab8c9">Wicket type <select data-sel="wicketType">${["bowled", "caught", "lbw", "run out", "stumped", "hit wicket", "retired"].map(w => `<option ${w === (s.wicketType || "bowled") ? "selected" : ""}>${w}</option>`).join("")}</select></label><label style="margin:0;display:flex;gap:6px;align-items:center;color:#aab8c9">Runs on Nb/Bye <select data-sel="extraRuns">${[0, 1, 2, 3, 4].map(r => `<option ${r === (s.extraRuns ?? 1) ? "selected" : ""}>${r}</option>`).join("")}</select></label></div>
      <div class="row" style="margin-top:10px"><button class="btn ghost sm" data-undo="${m.id}" data-innings="${cur.innings_no}">↶ Undo last ball</button><button class="btn ghost sm" data-totals="${m.id}" data-innings="${cur.innings_no}">Type totals</button><button class="btn ghost sm" data-end-innings="${m.id}" data-innings="${cur.innings_no}">End innings</button><button class="btn primary sm" data-end-match="${m.id}">End match 🏆</button></div></div>`;
  }
  function promptBatter(m, cur, outId, partner, slot) {
    const { s, available } = scorerState(m, cur);
    const others = available.filter(p => p !== partner);
    if (!others.length) { s.striker = partner || s.striker; s.nonStriker = null; saveScorer(); renderLive(); toast("No batters left — end the innings."); return; }
    $("batterTitle").textContent = `${nameOf(outId)} is out`; $("batterHint").textContent = `${nameOf(outId)} goes to the bench. Choose who comes in${slot === "striker" ? " (on strike)" : ""}.`;
    $("batterSel").innerHTML = others.map(id => `<option value="${id}">${esc(nameOf(id))}</option>`).join("");
    $("batterForm").onsubmit = e => { e.preventDefault(); s[slot] = $("batterSel").value; s[slot === "striker" ? "nonStriker" : "striker"] = partner; saveScorer(); closeDialog("batterDialog"); renderLive(); };
    $("batterDialog").showModal();
  }
  function promptBowler(m, cur) {
    const { s, bowlSide } = scorerState(m, cur);
    const others = bowlSide.filter(p => p !== s.bowler);
    $("bowlerTitle").textContent = `Over ${Math.floor(cur.balls / 6)} complete`; $("bowlerHint").textContent = `${nameOf(s.bowler)} finished the over. Batters change ends. Choose the next bowler${others.length ? " (same bowler can't bowl two in a row)" : ""}.`;
    $("bowlerSel").innerHTML = (others.length ? others : bowlSide).map(id => `<option value="${id}">${esc(nameOf(id))}</option>`).join("");
    $("bowlerForm").onsubmit = e => { e.preventDefault(); s.bowler = $("bowlerSel").value; saveScorer(); closeDialog("bowlerDialog"); renderLive(); };
    $("bowlerDialog").showModal();
  }
  // ---- chat
  function msgHtml(x) {
    const mine = x.profile_id === profile.id;
    if (x.kind === "system") return `<div class="msg system">${esc(x.body)}<small>${dtFmt(x.created_at)}</small></div>`;
    return `<div class="msg ${mine ? "mine" : ""} ${x.kind === "vote" ? "vote" : ""}">${(mine || isAdmin()) ? `<button class="del" data-del-msg="${x.id}" title="Delete">✕</button>` : ""}<b>${x.profile_id ? avHtml(x.profile_id, "msg-av") : ""}${esc(x.profile_id ? nameOf(x.profile_id) : "System")}${x.kind === "vote" ? " · vote note" : ""}</b>${esc(x.body)}<small>${dtFmt(x.created_at)}</small></div>`;
  }
  function renderChat() {
    const list = messages.filter(x => !x.match_id);
    const el = $("chatList"); const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    el.innerHTML = list.length ? list.map(msgHtml).join("") : '<div class="empty">No messages yet. Say hi!</div>';
    if (atBottom || currentPage !== "chat") el.scrollTop = el.scrollHeight;
    if (currentPage === "chat") markChatRead();
  }
  function markChatRead() { try { localStorage.setItem("ft_chat_read_" + profile.id, String(Date.now())); } catch (_) {} $("navChatBadge").classList.add("hidden"); }
  // ---- match centre dialog
  function openCentre(id, tab) {
    const m = matches.find(x => x.id === id); if (!m) return;
    $("centreMatchId").value = id; teamDraft = null;
    document.querySelectorAll("[data-ctab]").forEach(b => b.classList.toggle("active", b.dataset.ctab === (tab || "teams")));
    document.querySelectorAll(".ctab").forEach(p => p.classList.toggle("active", p.id === "ctab-" + (tab || "teams")));
    $("centreDialog").showModal(); renderCentre();
    const c = $("centreChat"); c.scrollTop = c.scrollHeight;
  }
  function renderCentre() {
    const id = $("centreMatchId").value; if (!id || !$("centreDialog").open) return;
    const m = matches.find(x => x.id === id); if (!m) { closeDialog("centreDialog"); return; }
    const st = stageOf(m);
    $("centreEyebrow").textContent = `MATCH CENTRE · ${st === "voting" ? "VOTING OPEN" : st === "live" ? "🔴 LIVE" : st === "done" ? "FULL TIME" : "TEAM LOCKED"}`;
    $("centreTitle").textContent = m.venue;
    $("centreMeta").innerHTML = `${dateFmt(m.match_date)}${m.start_time ? " · " + timeFmt(m.start_time) + (m.end_time ? " – " + timeFmt(m.end_time) : "") : ""}${m.overs ? ` · ${m.overs} overs` : isAdmin() && st !== "voting" && st !== "done" ? ` · <button class="text-btn" data-set-overs="${m.id}">set overs</button>` : ""}${m.venue_url ? ` · <a href="${esc(m.venue_url)}" target="_blank" rel="noopener">📍 Map ↗</a>` : ""} · ${money(m.total_cost)} total`;
    // teams
    const att = (m.match_attendance || []).map(a => a.profile_id); const tm = teamDraft || teamOf(m);
    const editable = canPick(m) && st !== "voting" && st !== "done";
    const li = (pid, t) => `<li><span>${avHtml(pid, "msg-av")}${esc(nameOf(pid))}${members.find(x => x.id === pid)?.playing_role ? ` <small class="muted">${roleLabel(members.find(x => x.id === pid).playing_role)}</small>` : ""}${(t === "A" ? m.captain_a : m.captain_b) === pid ? ' <span class="chip cap" style="padding:1px 6px">©️ captain</span>' : ""}</span>${editable ? `<button class="text-btn danger" data-team-move="${pid}" data-team-to="">remove</button>` : ""}</li>`;
    const col = t => `<div class="lineup"><h4>${esc(tname(m, t))} <span class="muted" style="font-size:11px">${tm[t].length} players</span></h4><ul>${tm[t].map(p => li(p, t)).join("") || '<li class="muted">No players yet</li>'}</ul></div>`;
    const pool = att.filter(p => !tm.A.includes(p) && !tm.B.includes(p));
    $("ctab-teams").innerHTML = st === "voting" ? `<div class="empty">Teams are picked once voting closes and the team sheet is locked.<br><br>${voteInfo(m).yes.length} in so far.</div>` :
      `<div class="lineups">${col("A")}${col("B")}</div>` +
      (editable ? `<div class="picker"><div class="attendance-head"><b>Unassigned (${pool.length})</b><span>${m.captain_a || m.captain_b ? "Captains and admin can pick" : "Admin picks (no captains set)"}</span></div><div class="picker-pool">${pool.map(p => `<span class="pick">${esc(nameOf(p))}<button class="toA" data-team-move="${p}" data-team-to="A">→ ${esc(tname(m, "A"))}</button><button class="toB" data-team-move="${p}" data-team-to="B">→ ${esc(tname(m, "B"))}</button></span>`).join("") || '<span class="muted">Everyone is assigned.</span>'}</div><div class="modal-actions"><button class="btn ghost sm" id="teamsShuffle" type="button">🎲 Shuffle evenly</button><button class="btn primary sm" id="teamsSave" type="button" ${teamDraft ? "" : "disabled"}>Save line-ups</button></div></div>` : (pool.length ? `<p class="hint">${pool.length} player${pool.length === 1 ? "" : "s"} not yet assigned to a team.</p>` : ""));
    // scorecard
    const inns = inningsOf(m);
    $("ctab-score").innerHTML = inns.length ? resultStrip(m) + inns.map(i => `<div class="innings-card"><h4><span>${i.innings_no === 1 ? "1st" : "2nd"} innings · ${esc(tname(m, i.batting_team))}</span><span>${i.runs}/${i.wickets} (${oversFmt(i.balls)} ov)${i.status === "live" ? ' <span class="status live">LIVE</span>' : ""}</span></h4>${statsTables(m, i.innings_no)}</div>`).join("") + (m.toss_winner ? `<p class="hint">Toss: ${esc(tname(m, m.toss_winner))} chose to ${m.toss_decision}.</p>` : "") :
      `<div class="empty">${st === "done" ? "No score was recorded for this match." : "No score yet. " + (isAdmin() && st === "locked" ? "Start the match from Fixtures to begin scoring." : "The admin starts the match; the scoreboard appears here once it's live.")}</div>`;
    // chat
    const list = messages.filter(x => x.match_id === m.id);
    $("centreChat").innerHTML = list.length ? list.map(msgHtml).join("") : '<div class="empty">No comments yet. Suggestions about time, venue or day go here.</div>';
  }
  function renderReports() {
    if (!isAdmin()) return;
    const deposits = transactions.filter(t => ["deposit", "credit"].includes(t.transaction_type) && Number(t.amount) > 0).reduce((a, t) => a + Number(t.amount), 0);
    const settled = matches.filter(m => m.status === "settled");
    $("reportDeposits").textContent = money(deposits); $("reportExpenses").textContent = money(settled.reduce((a, m) => a + Number(m.total_cost), 0)); $("reportMatches").textContent = matches.filter(m => m.play_status === "completed").length;
    $("reportTable").innerHTML = `<table><thead><tr><th>PLAYER</th><th>DEPOSITS / CREDITS</th><th>MATCH CHARGES</th><th>OTHER DEBITS</th><th>BALANCE</th><th>PLAYED</th><th>MOM</th><th>LAST ACTIVITY</th></tr></thead><tbody>${members.filter(m => m.approved).map(m => {
      const ts = transactions.filter(t => t.profile_id === m.id);
      const plus = ts.filter(t => Number(t.amount) > 0).reduce((a, t) => a + Number(t.amount), 0);
      const matchCharges = -ts.filter(t => t.transaction_type === "match_deduction").reduce((a, t) => a + Number(t.amount), 0);
      const debits = -ts.filter(t => t.transaction_type === "debit").reduce((a, t) => a + Number(t.amount), 0);
      const att = settled.filter(x => (x.match_attendance || []).some(a => a.profile_id === m.id)).length;
      const mom = matches.filter(x => x.mom_profile_id === m.id).length;
      const bal = balanceFor(m.id);
      return `<tr><td>${esc(m.full_name)}${m.active === false ? ' <span class="status inactive">INACTIVE</span>' : ""}</td><td class="amount-positive">${money(plus)}</td><td class="amount-negative">${money(matchCharges)}</td><td>${money(debits)}</td><td class="${bal < 0 ? "amount-negative" : ""}"><b>${money(bal)}</b></td><td>${att}</td><td>${mom ? "⭐ " + mom : "—"}</td><td>${ts.length ? dtFmt(ts[0].created_at) : "—"}</td></tr>`;
    }).join("")}</tbody></table>`;
  }

  // -------------------------------------------------------------- actions
  async function sendInvite(email, fullName) {
    const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL, shouldCreateUser: true, data: { full_name: fullName } } });
    if (error) throw error;
  }
  async function rpc(name, args, successMsg) {
    const { data, error } = await db.rpc(name, args); if (error) throw error;
    if (successMsg) toast(successMsg); await refreshAll(); return data;
  }
  function openMemberDialog(id) {
    const m = id ? members.find(x => x.id === id) : null;
    $("memberId").value = m?.id || ""; $("memberName").value = m?.full_name || ""; $("memberEmail").value = m?.email || ""; $("memberPhone").value = m?.phone || "";
    $("memberRole").value = m?.role || "member"; $("memberActive").value = m ? String(m.active !== false) : "true";
    $("memberEmail").disabled = !!m?.user_id;
    $("memberDialogTitle").textContent = m ? "Edit member" : "Add a member"; $("memberSubmit").textContent = m ? "Save changes" : "Add member";
    $("memberHint").textContent = m ? (m.user_id ? "This member has signed in, so their email is locked to their login." : "The member can sign up later with this email and will be linked automatically.") : "The member can sign up later with this email and will be linked and approved automatically.";
    document.querySelectorAll("#memberDialog .edit-only").forEach(el => el.classList.toggle("hidden", !m));
    document.querySelectorAll("#memberDialog .add-only").forEach(el => el.classList.toggle("hidden", !!m)); $("memberInvite").checked = true;
    $("memberDialog").showModal(); $("memberName").focus();
  }
  function attendeeCandidates(match) {
    const ids = new Set((match?.match_attendance || []).map(a => a.profile_id));
    return members.filter(m => (m.approved && m.active !== false) || ids.has(m.id));
  }
  function updateShareHint() {
    const n = $("attendanceChoices").querySelectorAll("input:checked").length;
    const total = Number($("matchCost").value || 0) + Number($("extraCost").value || 0);
    $("selectedCount").textContent = `${n} selected`;
    $("shareHint").textContent = n && total ? `${money(total)} split ${n} ways = ${money(total / n)} per player. Absent players pay ₹0.` : "The total turf and additional costs are divided equally among selected players. Absent players pay ₹0.";
  }
  function toggleVotingUi(on) { $("attendanceBlock").classList.toggle("hidden", on); $("votingHint").classList.toggle("hidden", !on); }
  function openMatchDialog(id) {
    const m = id ? matches.find(x => x.id === id) : null;
    const checked = new Set(m ? (m.match_attendance || []).map(a => a.profile_id) : attendeeCandidates(null).map(x => x.id));
    $("matchId").value = m?.id || ""; $("matchDate").value = m?.match_date || todayIso(); $("matchVenue").value = m?.venue || "";
    $("matchTime").value = m?.start_time ? m.start_time.slice(0, 5) : ""; $("matchEndTime").value = m?.end_time ? m.end_time.slice(0, 5) : ""; $("matchVenueUrl").value = m?.venue_url || ""; $("matchOvers").value = m?.overs || "";
    $("matchCost").value = m ? Number(m.turf_cost) : ""; $("extraCost").value = m ? Number(m.extra_cost) : 0; $("matchNotes").value = m?.notes || "";
    $("teamAName").value = m?.team_a_name && m.team_a_name !== "Team A" ? m.team_a_name : ""; $("teamBName").value = m?.team_b_name && m.team_b_name !== "Team B" ? m.team_b_name : "";
    const capOpts = '<option value="">— choose later —</option>' + activeMembers().map(x => `<option value="${x.id}">${esc(x.full_name)}</option>`).join("");
    $("captainA").innerHTML = capOpts; $("captainB").innerHTML = capOpts; $("captainA").value = m?.captain_a || ""; $("captainB").value = m?.captain_b || "";
    $("matchDialogTitle").textContent = m ? "Edit match" : "Create a turf match"; $("matchSubmit").textContent = m ? "Save changes" : "Create match";
    const votingMatch = m?.status === "voting";
    document.querySelectorAll("#matchDialog .add-only").forEach(el => el.classList.toggle("hidden", !!m));
    $("matchVoting").checked = !m; toggleVotingUi(!m || votingMatch);
    if (votingMatch) $("matchDialogTitle").textContent = "Edit match (voting open)";
    $("attendanceChoices").innerHTML = attendeeCandidates(m).map(x => `<label class="attendee"><input type="checkbox" value="${x.id}" ${checked.has(x.id) ? "checked" : ""}> ${esc(x.full_name)}${x.role === "admin" ? ' <small class="muted">(admin)</small>' : ""}</label>`).join("");
    updateShareHint(); $("matchDialog").showModal();
  }
  function openSettle(id) {
    const m = matches.find(x => x.id === id); if (!m) return;
    const att = m.match_attendance || [];
    $("settleMatchId").value = id;
    $("settleSummary").textContent = `${m.venue} · ${dateFmt(m.match_date)} · ${money(m.total_cost)} split between ${att.length} attending player${att.length === 1 ? "" : "s"}.`;
    const short = att.filter(a => balanceFor(a.profile_id) < Number(a.share_amount));
    $("settleShares").innerHTML = `<table><thead><tr><th>PLAYER</th><th>SHARE</th><th>BALANCE</th></tr></thead><tbody>${att.map(a => { const b = balanceFor(a.profile_id); const ok = b >= Number(a.share_amount); return `<tr><td>${esc(nameOf(a.profile_id))}</td><td>${money(a.share_amount)}</td><td class="${ok ? "amount-positive" : "amount-negative"}">${money(b)}${ok ? "" : " ⚠"}</td></tr>`; }).join("")}</tbody></table>` + (short.length ? `<p class="hint warn">${short.length} player${short.length === 1 ? " has" : "s have"} insufficient balance — settlement will be blocked until they top up.</p>` : "");
    $("settleDialog").showModal();
  }
  function openManage(id) {
    const m = members.find(x => x.id === id); if (!m) return;
    $("maTitle").textContent = m.full_name; $("maMeta").textContent = `${m.email || "no email"} · ${money(balanceFor(m.id))} · ${m.active === false ? "inactive" : m.approved ? "active" : "pending approval"}`;
    const b = (attr, icon, label, cls = "ghost") => `<button class="btn ${cls}" ${attr}="${m.id}" data-close="memberActions"><span>${icon}</span>${label}</button>`;
    $("maButtons").innerHTML = [
      !m.approved ? b("data-approve", "✅", "Approve member", "primary") : "",
      b("data-edit-member", "✏️", "Edit name, email, role, status"),
      m.approved ? b("data-adjust", "₹", "Wallet: deposit / credit / deduct") : "",
      m.email && m.active !== false ? b("data-invite", "✉️", m.user_id ? "Send login link" : "Resend invite") : "",
      m.id !== profile.id ? b("data-delete-member", "🗑️", "Delete member", "ghost danger") : ""
    ].filter(Boolean).join("");
    $("memberActions").showModal();
  }
  function openReview(id) {
    const r = requests.find(x => x.id === id); if (!r) return;
    $("reviewId").value = id; $("reviewNote").value = "";
    $("reviewSummary").innerHTML = `<b>${esc(nameOf(r.profile_id))}</b> says they paid <b class="amount-positive">${money(r.amount)}</b> via ${methodLabel(r.method)}${r.reference ? ` · ref <b>${esc(r.reference)}</b>` : ""}${r.note ? `<br><small class="muted">${esc(r.note)}</small>` : ""}<br><small class="muted">Submitted ${dtFmt(r.created_at)} · current balance ${money(balanceFor(r.profile_id))}</small>`;
    $("reviewDialog").showModal();
  }
  function openToss(id) {
    const m = matches.find(x => x.id === id); if (!m) return;
    $("tossMatchId").value = id; $("tossOvers").value = m.overs || 10; $("tossWinner").innerHTML = `<option value="A">${esc(tname(m, "A"))}</option><option value="B">${esc(tname(m, "B"))}</option>`;
    $("tossDialog").showModal();
  }
  function openEnd(id) {
    const m = matches.find(x => x.id === id); if (!m) return;
    const i1 = inningsOf(m).find(i => i.innings_no === 1), i2 = inningsOf(m).find(i => i.innings_no === 2);
    $("endMatchId").value = id; $("endText").value = "";
    $("endSummary").textContent = `${tname(m, "A")} ${teamScore(m, "A")} vs ${tname(m, "B")} ${teamScore(m, "B")}. Leave the winner on “auto” to decide by runs.`;
    $("endWinner").innerHTML = `<option value="">Auto (by score)</option><option value="A">${esc(tname(m, "A"))}</option><option value="B">${esc(tname(m, "B"))}</option><option value="tie">Tie</option><option value="none">No result / abandoned</option>`;
    $("endMom").innerHTML = '<option value="">— none —</option>' + (m.match_attendance || []).map(a => `<option value="${a.profile_id}">${esc(nameOf(a.profile_id))}</option>`).join("");
    $("endDialog").showModal();
  }
  function openTotals(id, no) {
    const m = matches.find(x => x.id === id); if (!m) return; const i = inningsOf(m).find(x => x.innings_no === Number(no));
    $("totalsMatchId").value = id; $("totalsInnings").value = no; $("totalsTitle").textContent = `${no === "1" || no === 1 ? "1st" : "2nd"} innings · ${i ? tname(m, i.batting_team) : ""}`;
    $("totalsRuns").value = i?.runs ?? 0; $("totalsWkts").value = i?.wickets ?? 0; $("totalsOvers").value = i ? `${Math.floor(i.balls / 6)}.${i.balls % 6}` : "0.0"; $("totalsDone").checked = i?.status === "completed";
    $("totalsDialog").showModal();
  }
  async function scoreBall(matchId, no, kind, runs) {
    const m = matches.find(x => x.id === matchId); const cur = m && inningsOf(m).find(i => i.innings_no === Number(no)); if (!m || !cur) return;
    const { s } = scorerState(m, cur); const extraRuns = Number(s.extraRuns ?? 1);
    if (!s.striker || !s.bowler) throw new Error("Pick the striker and the bowler first.");
    const args = { p_match_id: matchId, p_innings_no: Number(no), p_batter: s.striker, p_bowler: s.bowler, p_runs: 0, p_extra_type: null, p_extra_runs: 0, p_is_wicket: false, p_wicket_type: null, p_out_player: null };
    let batRuns = 0, legal = true;
    if (kind === "run") { args.p_runs = Number(runs); batRuns = Number(runs); }
    else if (kind === "wd") { args.p_extra_type = "wd"; args.p_extra_runs = 1; legal = false; }
    else if (kind === "nb") { args.p_extra_type = "nb"; args.p_extra_runs = 1; args.p_runs = extraRuns; batRuns = extraRuns; legal = false; }
    else if (kind === "b" || kind === "lb") { args.p_extra_type = kind; args.p_extra_runs = extraRuns; batRuns = extraRuns; }
    else if (kind === "w") { args.p_is_wicket = true; args.p_wicket_type = s.wicketType || "bowled"; args.p_out_player = s.striker; }
    const { data, error } = await db.rpc("score_ball", args); if (error) throw error;
    // strike rotation: odd runs swap; over end swaps again
    if (batRuns % 2 === 1 && !args.p_is_wicket) { [s.striker, s.nonStriker] = [s.nonStriker, s.striker]; }
    const outId = args.p_is_wicket ? args.p_out_player : null;
    const slot = outId === s.nonStriker ? "nonStriker" : "striker"; const partner = slot === "striker" ? s.nonStriker : s.striker;
    const overDone = !!data?.over_complete && data?.status === "live";
    if (overDone) { [s.striker, s.nonStriker] = [s.nonStriker, s.striker]; }
    saveScorer();
    await refreshAll();
    const fresh = matches.find(x => x.id === matchId); const curNow = fresh && inningsOf(fresh).find(i => i.innings_no === Number(no));
    if (data?.status === "completed") { toast(Number(no) === 1 ? "Innings over — second innings is live." : "Target reached / innings over. End the match when ready."); return; }
    if (outId && curNow) promptBatter(fresh, curNow, outId, partner, slot);
    else if (overDone && curNow) promptBowler(fresh, curNow);
  }
  function openAccount() {
    $("accName").value = profile.full_name || ""; $("accPhone").value = profile.phone || ""; $("accRole").value = profile.playing_role || ""; $("accBio").value = profile.bio || "";
    $("accAvatar").innerHTML = profile.avatar_url ? `<img src="${esc(profile.avatar_url)}" alt="">` : esc((profile.full_name || "P").trim()[0].toUpperCase());
    $("accAvatar").dataset.url = profile.avatar_url || ""; $("accPhotoHint").textContent = "JPG/PNG, resized to 256px.";
    $("accountDialog").showModal();
  }
  function resizeImage(file, size = 256) {
    return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => { const c = document.createElement("canvas"); const r = Math.max(size / img.width, size / img.height); c.width = size; c.height = size; const ctx = c.getContext("2d"); ctx.drawImage(img, (size - img.width * r) / 2, (size - img.height * r) / 2, img.width * r, img.height * r); c.toBlob(b => b ? resolve(b) : reject(new Error("Could not process image")), "image/jpeg", 0.85); }; img.onerror = () => reject(new Error("Not a valid image")); img.src = URL.createObjectURL(file); });
  }
  function careerStats(pid) {
    const per = []; let inn = 0;
    matches.filter(m => m.play_status === "completed" || m.play_status === "live").forEach(m => {
      inningsOf(m).forEach(i => {
        const st = playerStats(m, i.innings_no); const b = st.bat[pid], bw = st.bowl[pid];
        if (b || bw) per.push({ m, i, b, bw });
      });
    });
    const bats = per.filter(x => x.b); const bowls = per.filter(x => x.bw);
    const runs = bats.reduce((a, x) => a + x.b.runs, 0), ballsF = bats.reduce((a, x) => a + x.b.balls, 0), fours = bats.reduce((a, x) => a + x.b.fours, 0), sixes = bats.reduce((a, x) => a + x.b.sixes, 0), outs = bats.filter(x => x.b.out).length;
    const wk = bowls.reduce((a, x) => a + x.bw.wkts, 0), conc = bowls.reduce((a, x) => a + x.bw.runs, 0), bb = bowls.reduce((a, x) => a + x.bw.balls, 0);
    const hs = bats.reduce((a, x) => Math.max(a, x.b.runs), 0);
    const played = matches.filter(m => m.play_status === "completed" && (m.match_attendance || []).some(a => a.profile_id === pid)).length;
    const mom = matches.filter(m => m.mom_profile_id === pid).length;
    return { per, played, inns: bats.length, runs, ballsF, fours, sixes, outs, hs, wk, conc, bb, mom, sr: ballsF ? (runs / ballsF * 100).toFixed(1) : "—", avg: outs ? (runs / outs).toFixed(1) : runs ? "∞" : "—", econ: bb ? rr(conc, bb) : "—" };
  }
  function renderStats() {
    const sel = $("statsPlayer"); const cur = statsFor || profile.id;
    sel.innerHTML = members.filter(m => m.approved).map(m => `<option value="${m.id}" ${m.id === cur ? "selected" : ""}>${esc(m.full_name)}</option>`).join("");
    const pid = cur; const p = members.find(m => m.id === pid) || profile; const c = careerStats(pid);
    $("statsTitle").textContent = pid === profile.id ? "My stats" : `${p.full_name} · stats`;
    $("statsHero").innerHTML = `<div class="player-card">${avHtml(pid)}<div><h3>${esc(p.full_name)}</h3><div class="muted">${[roleLabel(p.playing_role), p.bio].filter(Boolean).map(esc).join(" · ") || "No playing role set — edit it from your account."}</div></div><div style="margin-left:auto;text-align:right"><div class="eyebrow">MATCHES</div><div style="font:400 34px var(--score)">${c.played}</div></div></div>
      <div class="stat hi"><b>${c.runs}</b><span>RUNS</span></div><div class="stat"><b>${c.hs}</b><span>HIGH SCORE</span></div><div class="stat"><b>${c.sr}</b><span>STRIKE RATE</span></div><div class="stat"><b>${c.avg}</b><span>AVERAGE</span></div><div class="stat"><b>${c.fours}/${c.sixes}</b><span>4s / 6s</span></div><div class="stat"><b>${c.inns}</b><span>INNINGS</span></div>
      <div class="stat hi"><b>${c.wk}</b><span>WICKETS</span></div><div class="stat"><b>${oversFmt(c.bb)}</b><span>OVERS BOWLED</span></div><div class="stat"><b>${c.econ}</b><span>ECONOMY</span></div><div class="stat"><b>${c.conc}</b><span>RUNS CONCEDED</span></div><div class="stat"><b>${c.mom}</b><span>PLAYER OF MATCH</span></div><div class="stat"><b>${c.inns ? Math.round(c.runs / c.inns) : 0}</b><span>RUNS / INNINGS</span></div>`;
    $("statsMatches").innerHTML = c.per.length ? `<table><thead><tr><th>MATCH</th><th>BATTING</th><th>BOWLING</th><th>RESULT</th></tr></thead><tbody>${c.per.slice().reverse().slice(0, 20).map(x => `<tr><td><b>${esc(x.m.venue)}</b><small class="muted"> · ${dateShort(x.m.match_date)}</small></td><td>${x.b ? `${x.b.runs}${x.b.out ? "" : "*"} (${x.b.balls})` : "—"}</td><td>${x.bw ? `${x.bw.wkts}/${x.bw.runs} (${oversFmt(x.bw.balls)})` : "—"}</td><td class="muted">${esc(x.m.result_text || (x.m.play_status === "live" ? "live" : ""))}${x.m.mom_profile_id === pid ? " ⭐" : ""}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">No ball-by-ball data yet for this player.</div>';
    const rows = members.filter(m => m.approved).map(m => ({ m, c: careerStats(m.id) })).filter(x => x.c.runs || x.c.wk || x.c.mom);
    rows.sort((a, b) => lbMode === "runs" ? b.c.runs - a.c.runs : lbMode === "wickets" ? b.c.wk - a.c.wk : b.c.mom - a.c.mom);
    $("leaderboard").innerHTML = rows.length ? `<table><thead><tr><th>#</th><th>PLAYER</th><th>${lbMode === "runs" ? "RUNS" : lbMode === "wickets" ? "WKTS" : "MOM"}</th><th>${lbMode === "runs" ? "SR" : lbMode === "wickets" ? "ECON" : "MATCHES"}</th></tr></thead><tbody>${rows.slice(0, 15).map((x, i) => `<tr><td>${i + 1}</td><td>${avHtml(x.m.id, "msg-av")}${esc(x.m.full_name)}</td><td><b>${lbMode === "runs" ? x.c.runs : lbMode === "wickets" ? x.c.wk : x.c.mom}</b></td><td class="muted">${lbMode === "runs" ? x.c.sr : lbMode === "wickets" ? x.c.econ : x.c.played}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">Leaderboard fills up once matches are scored ball-by-ball.</div>';
  }
  function go(page) {
    if ((page === "members" || page === "reports") && !isAdmin()) page = "overview";
    if (!PAGES.includes(page)) page = "overview";
    currentPage = page;
    document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === `page-${page}`));
    document.querySelectorAll(".nav-link[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
    const labels = { stats: ["CAREER", "Stats"], overview: ["PAVILION", "Overview"], members: ["THE SQUAD", "Members"], wallet: ["KIDDY BANK", isAdmin() ? "Wallets" : "My wallet"], deposits: ["TOP-UPS", "Deposits"], matches: ["FIXTURES", "Matches"], live: ["SCOREBOARD", "Live"], chat: ["DRESSING ROOM", "Club chat"], reports: ["CLUB INSIGHTS", "Reports"] };
    $("pageEyebrow").textContent = labels[page][0]; $("pageTitle").textContent = labels[page][1]; $("sidebar").classList.remove("open");
    if (page === "chat" && profile) { markChatRead(); const el = $("chatList"); el.scrollTop = el.scrollHeight; }
    window.scrollTo({ top: 0 });
  }
  function downloadCsv(rows, filename) {
    const csv = rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
  }
  function exportSummaryCsv() {
    const rows = [["Member", "Email", "Status", "Deposits and credits", "Match charges", "Other debits", "Balance", "Matches attended"]];
    members.filter(m => m.approved).forEach(m => { const ts = transactions.filter(t => t.profile_id === m.id); rows.push([m.full_name, m.email || "", m.active === false ? "inactive" : "active", ts.filter(t => Number(t.amount) > 0).reduce((a, t) => a + Number(t.amount), 0).toFixed(2), (-ts.filter(t => t.transaction_type === "match_deduction").reduce((a, t) => a + Number(t.amount), 0)).toFixed(2), (-ts.filter(t => t.transaction_type === "debit").reduce((a, t) => a + Number(t.amount), 0)).toFixed(2), balanceFor(m.id).toFixed(2), matches.filter(x => x.status === "settled" && (x.match_attendance || []).some(a => a.profile_id === m.id)).length]); });
    downloadCsv(rows, `finstack-turf-summary-${todayIso()}.csv`);
  }
  function exportLedgerCsv() {
    const rows = [["Date", "Member", "Type", "Description", "Amount"]];
    [...transactions].reverse().forEach(t => rows.push([new Date(t.created_at).toLocaleString("en-IN"), nameOf(t.profile_id), t.transaction_type, t.description, Number(t.amount).toFixed(2)]));
    downloadCsv(rows, `finstack-turf-ledger-${todayIso()}.csv`);
  }

  // ----------------------------------------------------------------- init
  async function init() {
    if (!configured) {
      $("configNote").textContent = "Setup required: edit js/config.js with your Supabase URL and public anon key (see README, steps 1–2).";
      $("configNote").classList.add("warn");
      document.querySelectorAll("#authView button").forEach(b => { if (!b.dataset.authTab) b.disabled = true; });
      return;
    }
    db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    $("configNote").textContent = "Secure sign-in powered by Supabase. · v" + APP_VERSION;
    let booted = false, pendingPw = null;
    const boot = async session => {
      if (session?.user) { user = session.user; if (await getProfile()) { showApp(); await refreshAll(); go(currentPage); startRealtime(); clearInterval(countdownTimer); countdownTimer = setInterval(tickCountdown, 30000); if ("Notification" in window && Notification.permission === "granted") pushSubscribe(false).catch(console.warn); if (pendingPw) { const f = pendingPw === "forced"; pendingPw = null; openSetPassword(f); } } }
      else { user = null; profile = null; stopRealtime(); showAuth(); }
    };
    db.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED") return;
      if (event === "PASSWORD_RECOVERY" || (event === "SIGNED_IN" && (arrivedVia === "magiclink" || arrivedVia === "invite" || arrivedVia === "signup") && !localStorage.getItem("ft_pw_" + session?.user?.id))) {
        history.replaceState(null, "", APP_URL); pendingPw = event === "PASSWORD_RECOVERY" ? "forced" : "offer";
      }
      booted = true; boot(session).catch(fail);
    });
    if (linkError) { toast(decodeURIComponent(linkError.replace(/\+/g, " ")) + " — ask the admin to send a fresh link.", true); history.replaceState(null, "", APP_URL); }
    const { data: { session }, error } = await db.auth.getSession(); if (error) throw error;
    if (!booted) await boot(session);
  }
  // ---- push notifications (work even when the app is closed) ----
  const urlB64ToU8 = b => { const p = "=".repeat((4 - b.length % 4) % 4); const r = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...r].map(c => c.charCodeAt(0))); };
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && cfg.VAPID_PUBLIC_KEY && !String(cfg.VAPID_PUBLIC_KEY).includes("YOUR_");
  async function pushSubscribe(interactive) {
    if (!pushSupported()) { if (interactive) toast(cfg.VAPID_PUBLIC_KEY ? "Push alerts are not supported in this browser. On iPhone, add the app to the Home Screen first." : "Push alerts are not configured yet (VAPID_PUBLIC_KEY missing in config.js).", true); return false; }
    const perm = interactive ? await Notification.requestPermission() : Notification.permission;
    if (perm !== "granted") { if (interactive) toast("Notifications were not allowed. You can enable them in your browser's site settings.", true); return false; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(cfg.VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await db.rpc("save_push_subscription", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_user_agent: navigator.userAgent });
    if (error) throw error;
    try { localStorage.setItem("ft_push_" + profile.id, "1"); } catch (_) {}
    return true;
  }
  function renderAlertsState() {
    const on = pushSupported() && Notification.permission === "granted" && (() => { try { return !!localStorage.getItem("ft_push_" + profile.id); } catch (_) { return false; } })();
    $("enableAlertsBtn").classList.toggle("hidden", on || !("Notification" in window)); $("alertsOn").classList.toggle("hidden", !on);
  }
  function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refreshAll().catch(console.error), 350); }
  function startRealtime() {
    stopRealtime(); if (!db.channel) return;
    realtimeChannel = db.channel("finstack-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `profile_id=eq.${profile.id}` }, payload => {
        const n = payload.new; notifications.unshift(n); renderBell(); toast(`🔔 ${n.title}`);
        if ("Notification" in window && Notification.permission === "granted" && !pushSupported()) { try { new Notification(n.title, { body: n.body || "", icon: "icons/icon-192.png", tag: n.id }); } catch (_) {} }
        scheduleRefresh();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, payload => { const x = payload.new; if (!messages.some(y => y.id === x.id)) { messages.push(x); renderChat(); renderCentre(); renderHeader(); if (!x.match_id && x.profile_id !== profile.id && currentPage !== "chat") toast(`💬 ${nameOf(x.profile_id)}: ${x.body.slice(0, 60)}`); } })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, payload => { messages = messages.filter(y => y.id !== payload.old?.id); renderChat(); renderCentre(); })
      .on("postgres_changes", { event: "*", schema: "public", table: "match_votes" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "match_innings" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "match_balls" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "match_teams" }, scheduleRefresh)
      .subscribe();
  }
  function stopRealtime() { if (realtimeChannel) { try { db.removeChannel(realtimeChannel); } catch (_) {} realtimeChannel = null; } }
  function openSetPassword(forced) {
    $("pwTitle").textContent = forced ? "Choose a new password" : "Welcome! Set a password";
    $("pwHint").textContent = forced ? "Enter the new password you want to use from now on." : "You're signed in via your email link. Set a password so you can also sign in with email + password next time (or skip and keep using email links).";
    $("pwSkip").classList.toggle("hidden", forced); $("pwNew").value = ""; $("pwNew2").value = "";
    $("pwDialog").showModal();
  }

  // --------------------------------------------------------------- events
  document.addEventListener("click", async e => {
    if ($("sidebar").classList.contains("open") && !e.target.closest("#sidebar,#menuToggle")) $("sidebar").classList.remove("open");
    if (!$("notifPanel").classList.contains("hidden") && !e.target.closest("#notifPanel,#bellBtn")) $("notifPanel").classList.add("hidden");
    const tab = e.target.closest("[data-auth-tab]"); if (tab) { const signup = tab.dataset.authTab === "signup"; document.querySelectorAll("#authView .tab").forEach(x => x.classList.toggle("active", x === tab)); $("loginForm").classList.toggle("hidden", signup); $("signupForm").classList.toggle("hidden", !signup); }
    const ct = e.target.closest("[data-ctab]"); if (ct && ct.classList.contains("tab")) { document.querySelectorAll(".centre-tabs .tab").forEach(x => x.classList.toggle("active", x === ct)); document.querySelectorAll(".ctab").forEach(p => p.classList.toggle("active", p.id === "ctab-" + ct.dataset.ctab)); }
    const nav = e.target.closest("[data-page]"); if (nav) go(nav.dataset.page);
    const goto = e.target.closest("[data-goto]"); if (goto) go(goto.dataset.goto);
    const mf = e.target.closest("[data-mfilter]"); if (mf) { matchFilter = mf.dataset.mfilter; document.querySelectorAll("[data-mfilter]").forEach(b => b.classList.toggle("active", b === mf)); renderMatches(); }
    const close = e.target.closest("[data-close]"); if (close) closeDialog(close.dataset.close);
    const om = e.target.closest("[data-open-match]"); if (om && !e.target.closest("a")) openCentre(om.dataset.openMatch, om.dataset.ctab);
    try {
      const approve = e.target.closest("[data-approve]"); if (approve) await rpc("admin_approve_member", { p_profile_id: approve.dataset.approve }, "Member approved.");
      const editM = e.target.closest("[data-edit-member]"); if (editM) openMemberDialog(editM.dataset.editMember);
      const delM = e.target.closest("[data-delete-member]"); if (delM && await confirmDialog("Delete member?", `Remove ${nameOf(delM.dataset.deleteMember)} from the club. Only possible if they have no wallet or match history — otherwise mark them inactive instead.`, "Delete member")) await rpc("admin_delete_member", { p_profile_id: delM.dataset.deleteMember }, "Member removed.");
      const adjust = e.target.closest("[data-adjust]"); if (adjust) { $("adjustMemberId").value = adjust.dataset.adjust; $("adjustTitle").textContent = `Wallet · ${nameOf(adjust.dataset.adjust)} (${money(balanceFor(adjust.dataset.adjust))})`; $("adjustAmount").value = ""; $("adjustReason").value = ""; $("adjustDialog").showModal(); }
      const settleBtn = e.target.closest("[data-settle]"); if (settleBtn) openSettle(settleBtn.dataset.settle);
      const editMatch = e.target.closest("[data-edit-match]"); if (editMatch) openMatchDialog(editMatch.dataset.editMatch);
      const delMatch = e.target.closest("[data-delete-match]"); if (delMatch) { const m = matches.find(x => x.id === delMatch.dataset.deleteMatch); if (m && await confirmDialog("Delete this match?", `${m.venue} on ${dateFmt(m.match_date)} (${money(m.total_cost)}) will be removed. No wallets are affected because it is unsettled.`, "Delete match")) await rpc("admin_delete_match", { p_match_id: m.id }, "Match deleted."); }
      const inv = e.target.closest("[data-invite]"); if (inv) { const m = members.find(x => x.id === inv.dataset.invite); if (m && await confirmDialog("Send email?", `Email a one-tap login link to ${m.full_name} at ${m.email}?`, "Send link")) { await sendInvite(m.email, m.full_name); toast(`Login link sent to ${m.email}.`); } }
      const vote = e.target.closest("[data-vote]"); if (vote) { const cEl = document.querySelector(`[data-vote-comment="${vote.dataset.vote}"]`); const comment = cEl ? cEl.value.trim() : ""; const r = await rpc("member_vote", { p_match_id: vote.dataset.vote, p_vote: vote.dataset.voteValue, p_comment: comment || null }); toast(r === "closed" ? "Vote recorded — everyone has voted, team sheet is locked." : (vote.dataset.voteValue === "yes" ? "You're in! 🏏" : "Noted — you're out for this one.") + (comment ? " Your suggestion was posted." : "")); }
      const closeV = e.target.closest("[data-close-voting]"); if (closeV) { const m = matches.find(x => x.id === closeV.dataset.closeVoting); const vi = m ? voteInfo(m) : null; if (m && await confirmDialog("Close voting?", `${vi.yes.length} player${vi.yes.length === 1 ? "" : "s"} said they're in${vi.pending.length ? `, ${vi.pending.length} haven't voted` : ""}. The cost of ${money(m.total_cost)} will be split ${vi.yes.length ? "as " + money(Number(m.total_cost) / vi.yes.length) + " each" : "among those in"}. You can still edit attendance before settling.`, "Close voting")) await rpc("admin_close_voting", { p_match_id: m.id }, "Voting closed. Team sheet locked and players notified."); }
      const reopen = e.target.closest("[data-reopen-voting]"); if (reopen && await confirmDialog("Reopen voting?", "Attendance will be unlocked and everyone is notified to confirm again. Existing votes are kept.", "Reopen voting")) await rpc("admin_reopen_voting", { p_match_id: reopen.dataset.reopenVoting }, "Voting reopened.");
      const remind = e.target.closest("[data-remind]"); if (remind) { const n = await rpc("admin_remind_voters", { p_match_id: remind.dataset.remind }); toast(n ? `Reminder sent to ${n} member${n === 1 ? "" : "s"}.` : "Everyone has already voted."); }
      const notif = e.target.closest("[data-notif]"); if (notif) { const n = notifications.find(x => x.id === notif.dataset.notif); if (n && !n.read) { n.read = true; renderBell(); db.rpc("mark_notifications_read", { p_ids: [n.id] }).then(() => {}, console.error); } $("notifPanel").classList.add("hidden"); const lm = n?.match_id && matches.find(x => x.id === n.match_id); go(lm && lm.play_status === "live" ? "live" : n?.match_id ? "matches" : n?.kind === "deposit" ? "deposits" : n?.kind === "wallet" ? "wallet" : "overview"); }
      const review = e.target.closest("[data-review]"); if (review) openReview(review.dataset.review);
      const cancelReq = e.target.closest("[data-cancel-request]"); if (cancelReq && await confirmDialog("Cancel request?", "Your deposit request will be withdrawn.", "Cancel request")) await rpc("member_cancel_deposit_request", { p_request_id: cancelReq.dataset.cancelRequest }, "Request cancelled.");
      // ---- v4: teams, scoring, chat
      const tmv = e.target.closest("[data-team-move]"); if (tmv) { const m = matches.find(x => x.id === $("centreMatchId").value); if (m) { teamDraft = teamDraft || teamOf(m); const pid = tmv.dataset.teamMove; teamDraft.A = teamDraft.A.filter(x => x !== pid); teamDraft.B = teamDraft.B.filter(x => x !== pid); if (tmv.dataset.teamTo) teamDraft[tmv.dataset.teamTo].push(pid); renderCentre(); } }
      if (e.target.id === "teamsShuffle") { const m = matches.find(x => x.id === $("centreMatchId").value); if (m) { const ids = (m.match_attendance || []).map(a => a.profile_id).sort(() => Math.random() - 0.5); teamDraft = { A: [], B: [] }; if (m.captain_a) { teamDraft.A.push(m.captain_a); } if (m.captain_b) { teamDraft.B.push(m.captain_b); } ids.filter(p => p !== m.captain_a && p !== m.captain_b).forEach(p => (teamDraft.A.length <= teamDraft.B.length ? teamDraft.A : teamDraft.B).push(p)); renderCentre(); } }
      if (e.target.id === "teamsSave") { const m = matches.find(x => x.id === $("centreMatchId").value); if (m && teamDraft) { const assignments = [...teamDraft.A.map(p => ({ profile_id: p, team: "A" })), ...teamDraft.B.map(p => ({ profile_id: p, team: "B" }))]; await rpc("set_match_teams", { p_match_id: m.id, p_assignments: assignments }, "Line-ups saved. Everyone has been notified."); teamDraft = null; renderCentre(); } }
      const sm = e.target.closest("[data-start-match]"); if (sm) openToss(sm.dataset.startMatch);
      const em = e.target.closest("[data-end-match]"); if (em) openEnd(em.dataset.endMatch);
      const rm = e.target.closest("[data-reopen-match]"); if (rm && await confirmDialog("Reopen result?", "The match goes back to live so the score can be corrected. Members are not notified until you end it again.", "Reopen")) await rpc("admin_reopen_match", { p_match_id: rm.dataset.reopenMatch }, "Match reopened for scoring.");
      const tot = e.target.closest("[data-totals]"); if (tot) openTotals(tot.dataset.totals, tot.dataset.innings);
      const undo = e.target.closest("[data-undo]"); if (undo && await confirmDialog("Undo last ball?", "The last recorded delivery will be removed.", "Undo")) await rpc("undo_ball", { p_match_id: undo.dataset.undo, p_innings_no: Number(undo.dataset.innings) }, "Last ball removed.");
      const ei = e.target.closest("[data-end-innings]"); if (ei) { const m = matches.find(x => x.id === ei.dataset.endInnings); const i = m && inningsOf(m).find(x => x.innings_no === Number(ei.dataset.innings)); if (i && await confirmDialog("End innings?", `${tname(m, i.batting_team)} finish on ${i.runs}/${i.wickets} (${oversFmt(i.balls)} ov).`, "End innings")) await rpc("set_innings_total", { p_match_id: m.id, p_innings_no: i.innings_no, p_runs: i.runs, p_wickets: i.wickets, p_overs: Number(`${Math.floor(i.balls / 6)}.${i.balls % 6}`), p_completed: true }, "Innings closed."); }
      const bb = e.target.closest("[data-ball]"); if (bb) { const panel = bb.closest("[data-scorer]"); bb.disabled = true; try { await scoreBall(panel.dataset.scorer, panel.dataset.innings, bb.dataset.ball, bb.dataset.runs); } finally { bb.disabled = false; } }
      const sw = e.target.closest("[data-swap]"); if (sw) { const st = scorerSel[sw.dataset.swap] ||= {}; [st.striker, st.nonStriker] = [st.nonStriker, st.striker]; saveScorer(); renderLive(); }
      const mg = e.target.closest("[data-manage]"); if (mg) openManage(mg.dataset.manage);
      const so = e.target.closest("[data-set-overs]"); if (so) { const v = prompt("Overs per side (1–50):", "10"); if (v) await rpc("set_match_overs", { p_match_id: so.dataset.setOvers, p_overs: Number(v) }, "Overs set."); }
      const lb = e.target.closest("[data-lb]"); if (lb) { lbMode = lb.dataset.lb; document.querySelectorAll("[data-lb]").forEach(b => b.classList.toggle("active", b === lb)); renderStats(); }
      if (e.target.id === "accountBtn" || e.target.closest("#accountBtn")) openAccount();
      if (e.target.id === "clearChatBtn") { const v = prompt("Delete group-chat messages older than how many days? (0 = clear everything)", "7"); if (v !== null) { const n = await rpc("admin_clear_chat", { p_older_than_days: Number(v) }); toast(`Deleted ${n} message${n === 1 ? "" : "s"}.`); } }
      const dm = e.target.closest("[data-del-msg]"); if (dm && await confirmDialog("Delete message?", "This removes the message for everyone.", "Delete")) { const { error } = await db.rpc("delete_message", { p_message_id: dm.dataset.delMsg }); if (error) throw error; messages = messages.filter(x => x.id !== dm.dataset.delMsg); renderChat(); renderCentre(); }
    } catch (err) { fail(err); }
  });
  document.addEventListener("change", e => { const sel = e.target.closest("[data-sel]"); if (sel) { const panel = sel.closest("[data-scorer]"); if (panel) { const st = scorerSel[panel.dataset.key] ||= {}; st[sel.dataset.sel] = sel.dataset.sel === "extraRuns" ? Number(sel.value) : sel.value; if (sel.dataset.sel === "striker" && st.nonStriker === st.striker) st.nonStriker = null; if (sel.dataset.sel === "nonStriker" && st.striker === st.nonStriker) st.striker = null; saveScorer(); renderLive(); } } });

  const notReady = () => { if (!db) { toast("Not connected yet: add your Supabase URL and anon key to js/config.js first (README step 1–2).", true); return true; } return false; };
  $("signInForm").addEventListener("submit", async e => { e.preventDefault(); if (notReady()) return; busy(e.target, true); try { const { error } = await db.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPassword").value }); if (error) throw error; } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("registerForm").addEventListener("submit", async e => {
    e.preventDefault(); if (notReady()) return; busy(e.target, true);
    try {
      const { data, error } = await db.auth.signUp({ email: $("registerEmail").value.trim(), password: $("registerPassword").value, options: { data: { full_name: $("registerName").value.trim() } } });
      if (error) throw error;
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw new Error("An account with this email already exists (you were invited). Go to Sign in and use “Email me a login link” or “Forgot password?” to set your password.");
      }
      toast(data.session ? "Account created." : "Check your email to confirm signup, then sign in.");
      document.querySelector('[data-auth-tab="login"]').click(); $("loginEmail").value = $("registerEmail").value.trim();
    } catch (err) { fail(err); } finally { busy(e.target, false); }
  });
  $("forgotBtn").addEventListener("click", async () => {
    if (notReady()) return;
    const email = $("loginEmail").value.trim(); if (!email) return toast("Enter your email address first, then click Forgot password.", true);
    try { const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.href.split("#")[0] }); if (error) throw error; toast("Password reset email sent."); } catch (err) { fail(err); }
  });
  $("magicBtn").addEventListener("click", async () => {
    if (notReady()) return;
    const email = $("loginEmail").value.trim(); if (!email) return toast("Enter your email address first, then click “Email me a login link”.", true);
    try { const { error } = await db.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL, shouldCreateUser: false } }); if (error) throw error; toast(`Login link sent to ${email}. Check your inbox (and spam).`); } catch (err) { fail(/Signups not allowed/i.test(err.message) ? new Error("This email is not registered. Ask the admin to add you first.") : err); }
  });
  const pwError = msg => { $("pwError").textContent = msg || ""; $("pwError").classList.toggle("hidden", !msg); };
  $("pwForm").addEventListener("submit", async e => {
    e.preventDefault(); const a = $("pwNew").value, b = $("pwNew2").value; pwError("");
    if (a.length < 8) return pwError("Password must be at least 8 characters."); if (a !== b) return pwError("Passwords do not match.");
    busy(e.target, true);
    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session) throw new Error("Your sign-in link has expired. Ask the admin for a new link, or use “Email me a login link” on the sign-in page.");
      const { error } = await db.auth.updateUser({ password: a }); if (error) throw error;
      try { localStorage.setItem("ft_pw_" + user?.id, "1"); } catch (_) {}
      toast("Password saved. You can now sign in with email + password."); closeDialog("pwDialog");
    } catch (err) { console.error(err); pwError(err.message || "Could not save the password. Please try again."); } finally { busy(e.target, false); }
  });
  $("pwSkip").addEventListener("click", () => { try { localStorage.setItem("ft_pw_" + user?.id, "1"); } catch (_) {} closeDialog("pwDialog"); });
  $("signOutBtn").addEventListener("click", async () => { const { error } = await db.auth.signOut(); if (error) fail(error); });
  ["refreshMembers", "refreshWallet", "refreshDeposits", "refreshLive"].forEach(id => $(id).addEventListener("click", () => refreshAll().then(() => toast("Refreshed.")).catch(fail)));
  $("showInactive").addEventListener("change", renderMembers);
  $("walletFilter").addEventListener("change", renderWallet);
  $("addMemberBtn").addEventListener("click", () => openMemberDialog(null));
  $("recordDepositBtn").addEventListener("click", () => { $("depositAmount").value = 500; $("depositNote").value = ""; $("depositDialog").showModal(); });
  $("newMatchBtn").addEventListener("click", () => openMatchDialog(null));
  $("attendanceChoices").addEventListener("change", updateShareHint);
  $("matchCost").addEventListener("input", updateShareHint); $("extraCost").addEventListener("input", updateShareHint);
  $("selectAll").addEventListener("click", () => { $("attendanceChoices").querySelectorAll("input").forEach(i => i.checked = true); updateShareHint(); });
  $("selectNone").addEventListener("click", () => { $("attendanceChoices").querySelectorAll("input").forEach(i => i.checked = false); updateShareHint(); });

  $("memberForm").addEventListener("submit", async e => {
    e.preventDefault(); busy(e.target, true);
    try {
      const id = $("memberId").value;
      if (id) await rpc("admin_update_member", { p_profile_id: id, p_full_name: $("memberName").value.trim(), p_email: $("memberEmail").value.trim(), p_phone: $("memberPhone").value.trim(), p_role: $("memberRole").value, p_active: $("memberActive").value === "true" }, "Member updated.");
      else {
        const email = $("memberEmail").value.trim(), name = $("memberName").value.trim();
        await rpc("admin_add_member", { p_full_name: name, p_email: email, p_phone: $("memberPhone").value.trim() }, "Member added.");
        if (email && $("memberInvite").checked) { try { await sendInvite(email, name); toast(`Member added and invite emailed to ${email}.`); } catch (err) { toast(`Member added, but the invite email failed: ${err.message}. Use “Resend invite” later.`, true); } }
      }
      closeDialog("memberDialog");
    } catch (err) { fail(err); } finally { busy(e.target, false); }
  });
  $("depositForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("admin_wallet_adjustment", { p_profile_id: $("depositMember").value, p_type: "deposit", p_amount: Number($("depositAmount").value), p_description: $("depositNote").value.trim() || "Member deposit" }, "Deposit recorded."); closeDialog("depositDialog"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("adjustForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("admin_wallet_adjustment", { p_profile_id: $("adjustMemberId").value, p_type: $("adjustType").value, p_amount: Number($("adjustAmount").value), p_description: $("adjustReason").value.trim() }, "Wallet updated."); closeDialog("adjustDialog"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("requestForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("member_request_deposit", { p_amount: Number($("reqAmount").value), p_method: $("reqMethod").value, p_reference: $("reqReference").value.trim(), p_note: $("reqNote").value.trim() }, "Request submitted. The admin will confirm it soon."); $("reqReference").value = ""; $("reqNote").value = ""; } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("matchForm").addEventListener("submit", async e => {
    e.preventDefault(); busy(e.target, true);
    try {
      const id = $("matchId").value;
      const editing = id ? matches.find(x => x.id === id) : null;
      const voting = editing ? editing.status === "voting" : $("matchVoting").checked;
      const ids = voting ? [] : [...$("attendanceChoices").querySelectorAll("input:checked")].map(x => x.value);
      if (!voting && !ids.length) throw new Error("Select at least one attending player.");
      if ($("captainA").value && $("captainA").value === $("captainB").value) throw new Error("Choose two different captains.");
      const args = { p_match_date: $("matchDate").value, p_venue: $("matchVenue").value.trim(), p_turf_cost: Number($("matchCost").value), p_extra_cost: Number($("extraCost").value || 0), p_notes: $("matchNotes").value.trim(), p_attendee_ids: ids };
      let matchId = id;
      if (id) { const { error } = await db.rpc("admin_update_match", { p_match_id: id, ...args }); if (error) throw error; }
      else { const { data, error } = await db.rpc("admin_create_match", { ...args, p_open_voting: voting }); if (error) throw error; matchId = data; }
      if ($("matchTime").value && $("matchEndTime").value && $("matchEndTime").value <= $("matchTime").value) throw new Error("End time must be after the start time.");
      const det = { p_match_id: matchId, p_start_time: $("matchTime").value || null, p_end_time: $("matchEndTime").value || null, p_venue_url: $("matchVenueUrl").value.trim() || null, p_overs: $("matchOvers").value ? Number($("matchOvers").value) : null, p_captain_a: $("captainA").value || null, p_captain_b: $("captainB").value || null, p_team_a_name: $("teamAName").value.trim() || null, p_team_b_name: $("teamBName").value.trim() || null };
      const d = await db.rpc("admin_set_match_details", det); if (d.error) throw d.error;
      toast(id ? "Match updated." : voting ? "Match proposed. Every member has been notified to vote." : "Match created. Review it and settle when ready.");
      await refreshAll(); closeDialog("matchDialog");
    } catch (err) { fail(err); } finally { busy(e.target, false); }
  });
  $("settleForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("admin_settle_match", { p_match_id: $("settleMatchId").value }, "Match settled. Wallets have been updated."); closeDialog("settleDialog"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("reviewForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("admin_review_deposit", { p_request_id: $("reviewId").value, p_approve: true, p_note: $("reviewNote").value.trim() }, "Deposit approved and wallet credited."); closeDialog("reviewDialog"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("rejectBtn").addEventListener("click", async () => { try { await rpc("admin_review_deposit", { p_request_id: $("reviewId").value, p_approve: false, p_note: $("reviewNote").value.trim() }, "Request rejected."); closeDialog("reviewDialog"); } catch (err) { fail(err); } });
  $("tossForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("start_match", { p_match_id: $("tossMatchId").value, p_toss_winner: $("tossWinner").value, p_toss_decision: $("tossDecision").value, p_overs: Number($("tossOvers").value) }, "Match is live! Everyone has been notified."); closeDialog("tossDialog"); go("live"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("endForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("end_match", { p_match_id: $("endMatchId").value, p_winner: $("endWinner").value || null, p_result_text: $("endText").value.trim() || null, p_mom: $("endMom").value || null }, "Result recorded and everyone notified. 🏆"); closeDialog("endDialog"); go("matches"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("totalsForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("set_innings_total", { p_match_id: $("totalsMatchId").value, p_innings_no: Number($("totalsInnings").value), p_runs: Number($("totalsRuns").value), p_wickets: Number($("totalsWkts").value), p_overs: Number($("totalsOvers").value), p_completed: $("totalsDone").checked }, "Score updated."); closeDialog("totalsDialog"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("chatForm").addEventListener("submit", async e => { e.preventDefault(); const body = $("chatInput").value.trim(); if (!body) return; $("chatInput").value = ""; try { const { data, error } = await db.rpc("post_message", { p_body: body, p_match_id: null }); if (error) throw error; const r = await db.from("messages").select("id,profile_id,match_id,kind,body,created_at").eq("id", data).maybeSingle(); if (r.data && !messages.some(y => y.id === r.data.id)) { messages.push(r.data); renderChat(); } } catch (err) { fail(err); $("chatInput").value = body; } });
  $("centreChatForm").addEventListener("submit", async e => { e.preventDefault(); const body = $("centreChatInput").value.trim(); if (!body) return; $("centreChatInput").value = ""; try { const { error } = await db.rpc("post_message", { p_body: body, p_match_id: $("centreMatchId").value }); if (error) throw error; const r = await db.from("messages").select("id,profile_id,match_id,kind,body,created_at").eq("match_id", $("centreMatchId").value).order("created_at"); if (!r.error) { r.data.forEach(x => { if (!messages.some(y => y.id === x.id)) messages.push(x); }); renderCentre(); const c = $("centreChat"); c.scrollTop = c.scrollHeight; } } catch (err) { fail(err); $("centreChatInput").value = body; } });
  $("statsPlayer").addEventListener("change", () => { statsFor = $("statsPlayer").value; renderStats(); });
  $("accPhoto").addEventListener("change", async () => {
    const f = $("accPhoto").files[0]; if (!f) return;
    try { $("accPhotoHint").textContent = "Uploading…"; const blob = await resizeImage(f); const path = `${profile.id}/avatar-${Date.now()}.jpg`;
      const up = await db.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg", upsert: true }); if (up.error) throw up.error;
      const { data } = db.storage.from("avatars").getPublicUrl(path); $("accAvatar").dataset.url = data.publicUrl; $("accAvatar").innerHTML = `<img src="${esc(data.publicUrl)}" alt="">`; $("accPhotoHint").textContent = "Photo uploaded — click Save profile.";
    } catch (err) { $("accPhotoHint").textContent = "Upload failed: " + (err.message || err); }
  });
  $("accountForm").addEventListener("submit", async e => { e.preventDefault(); busy(e.target, true); try { await rpc("update_my_profile", { p_full_name: $("accName").value.trim(), p_phone: $("accPhone").value.trim(), p_playing_role: $("accRole").value || null, p_avatar_url: $("accAvatar").dataset.url || null, p_bio: $("accBio").value.trim() }, "Profile saved."); profile = members.find(m => m.id === profile.id) || profile; renderHeader(); closeDialog("accountDialog"); } catch (err) { fail(err); } finally { busy(e.target, false); } });
  $("exportCsv").addEventListener("click", exportSummaryCsv); $("exportLedgerCsv").addEventListener("click", exportLedgerCsv);
  $("menuToggle").addEventListener("click", () => $("sidebar").classList.toggle("open"));
  $("bellBtn").addEventListener("click", () => $("notifPanel").classList.toggle("hidden"));
  $("markAllRead").addEventListener("click", async () => { notifications.forEach(n => n.read = true); renderBell(); try { const { error } = await db.rpc("mark_notifications_read", { p_ids: null }); if (error) throw error; } catch (err) { fail(err); } });
  $("enableAlertsBtn").addEventListener("click", async () => { try { if (await pushSubscribe(true)) toast("Push alerts enabled on this device — you'll get match alerts even when the app is closed."); renderBell(); } catch (err) { fail(err); } });
  if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("message", e => { if (e.data?.type === "navigate") { const pg = new URL(e.data.url).searchParams.get("page"); if (pg) go(pg); } });
  $("matchVoting").addEventListener("change", () => toggleVotingUi($("matchVoting").checked));
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; $("installBtn").classList.remove("hidden"); });
  $("installBtn").addEventListener("click", async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $("installBtn").classList.add("hidden"); });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(console.warn);
  init().catch(fail);
})();
