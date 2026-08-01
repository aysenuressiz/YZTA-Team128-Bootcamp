// dashboard.js — aile paneli: özet, check-in, ilaç, uyarı, profil

const API_BASE_URL = (window.CONFIG && CONFIG.API_BASE_URL) || "http://127.0.0.1:8000/api";
const WS_BASE_URL = (window.CONFIG && CONFIG.WS_BASE_URL) || "ws://127.0.0.1:8000";
const ALERT_POLL_MS = 30000;

let familyWs = null;
let familyWsReconnectTimer = null;
let alertPollTimer = null;
let lastSeenAlertKey = null;
let criticalAudioCtx = null;
let familyCheckinCache = [];
let familyCheckinRange = "week";
let cachedAlerts = [];
let openAlertCount = 0;
let alertFilterMode = "open"; // open | all
let adherenceDays = 7;
let pendingCriticalAlertId = null;
let familyProfileCache = null;
let familyProfileEditing = false;

const DEFAULT_NOTIFY_PREFS = {
    critical: true,
    medication_missed: true,
    wrong_medication: true,
    checkin_missing: true,
    sound: true,
    banner: true,
    sms: true,
};

function loadNotifyPrefs() {
    try {
        const raw = localStorage.getItem("family_notify_prefs");
        if (!raw) return { ...DEFAULT_NOTIFY_PREFS };
        return { ...DEFAULT_NOTIFY_PREFS, ...JSON.parse(raw) };
    } catch (_) {
        return { ...DEFAULT_NOTIFY_PREFS };
    }
}

function saveNotifyPrefs(prefs) {
    localStorage.setItem("family_notify_prefs", JSON.stringify(prefs));
    // Eski SMS anahtarıyla uyum
    localStorage.setItem("family_sms_notify", prefs.sms ? "1" : "0");
}

function getNotifyPrefs() {
    return loadNotifyPrefs();
}

function isAlertTypeEnabled(alertType) {
    const prefs = getNotifyPrefs();
    if (alertType === "conversation_risk" || alertType === "critical_health") return prefs.critical !== false;
    if (alertType === "medication_missed") return prefs.medication_missed !== false;
    if (alertType === "wrong_medication" || alertType === "medication_wrong") return prefs.wrong_medication !== false;
    if (alertType === "checkin_missing") return prefs.checkin_missing !== false;
    if (alertType === "mood_decline") return prefs.critical !== false;
    return true;
}

function filterAlertsByPrefs(alerts) {
    return (alerts || []).filter((a) => isAlertTypeEnabled(a.alert_type));
}

document.addEventListener("DOMContentLoaded", () => {
    const role = localStorage.getItem("user_role");
    if (role !== "family") {
        alert("Bu panele erişim yetkiniz yok. Lütfen Aile Girişi yapın.");
        window.location.href = "login.html";
        return;
    }

    const familyName = localStorage.getItem("family_name") || "Değerli Refakatçimiz";
    const elderlyName = localStorage.getItem("elderly_name") || "Yakınınız";
    const elderlyId = localStorage.getItem("elderly_id");

    document.getElementById("welcome-family").textContent = `Hoş geldiniz, ${familyName}`;
    document.getElementById("elderly-title").textContent = `Takip Edilen: ${elderlyName}`;

    // Anında boş durumlar — API beklerken "Yükleniyor"da takılı kalmasın
    setDashboardPlaceholders(elderlyName);

    const dismissBtn = document.getElementById("critical-alert-dismiss");
    if (dismissBtn) dismissBtn.addEventListener("click", hideCriticalAlert);

    initNotifyPrefs();

    if (!elderlyId) {
        showDashboardBanner("Yaşlı bağlantısı bulunamadı. Çıkış yapıp aile girişi ile tekrar deneyin.");
        return;
    }

    // Paralel yükle — hiçbir sekme diğerini bloklamasın
    Promise.allSettled([
        fetchDashboardData(),
        loadFamilyCheckins(),
        loadFamilyElderProfile(),
        loadWeeklySummary(),
        loadMoodAnalysis(),
    ]).then(() => {
        startFamilyRealtime().catch((err) => console.warn(err));
    });
});

function setDashboardPlaceholders(elderlyName) {
    const heroTitle = document.getElementById("status-hero-title");
    const heroLine = document.getElementById("status-hero-line");
    const heroMood = document.getElementById("status-hero-mood");
    const health = document.getElementById("health-status");
    const pill = document.getElementById("pill-status");
    const activity = document.getElementById("activity-status");
    const activityHint = document.getElementById("activity-hint");
    const aiBox = document.getElementById("ai-summary");
    const alertsList = document.getElementById("all-alerts-list");
    const checkinList = document.getElementById("family-checkin-list");
    const chatBox = document.getElementById("family-chat-transcript");
    const weeklyBullets = document.getElementById("weekly-bullets");
    const moodInsight = document.getElementById("mood-insight");
    const trend = document.getElementById("weekly-trend-chart");

    if (heroTitle) heroTitle.textContent = `${elderlyName} — Genel Durum`;
    if (heroLine) heroLine.textContent = "Veriler getiriliyor…";
    if (heroMood) {
        heroMood.textContent = "—";
        heroMood.className = "status-hero-mood tone-unknown";
    }
    if (health) health.textContent = "—";
    if (pill) pill.textContent = "—";
    if (activity) activity.textContent = "—";
    if (activityHint) activityHint.textContent = "Kiosk etkileşimi";
    if (aiBox) aiBox.textContent = "Özet hazırlanıyor…";
    if (alertsList) alertsList.innerHTML = '<p class="muted">Uyarılar yükleniyor…</p>';
    if (checkinList) checkinList.innerHTML = '<p class="muted">Check-in yükleniyor…</p>';
    if (chatBox) chatBox.innerHTML = '<p class="muted">Sohbet sekmesine girince yüklenir.</p>';
    if (weeklyBullets) weeklyBullets.innerHTML = '<li class="muted">Haftalık özet yükleniyor…</li>';
    if (moodInsight) moodInsight.textContent = "Ruh hali analizi yükleniyor…";
    if (trend) trend.innerHTML = '<p class="muted">Grafik yükleniyor…</p>';
    renderMoodDayChart("weekly-mood-chart", []);
    renderMoodDayChart("mood-checkin-chart", []);
}

function showDashboardBanner(message) {
    const heroLine = document.getElementById("status-hero-line");
    if (heroLine) heroLine.textContent = message;
    const aiBox = document.getElementById("ai-summary");
    if (aiBox) aiBox.textContent = message;
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        return { ok: response.ok, status: response.status, data };
    } catch (error) {
        return { ok: false, status: 0, data: { detail: error.name === "AbortError" ? "Zaman aşımı" : String(error.message || error) } };
    } finally {
        clearTimeout(timer);
    }
}

function setLiveConnectionStatus(isOnline) {
    const el = document.getElementById("live-connection");
    if (!el) return;
    el.classList.toggle("is-offline", !isOnline);
    el.classList.toggle("status-good", isOnline);
    el.classList.toggle("status-warn", !isOnline);
    el.innerHTML = isOnline
        ? '<i class="fas fa-circle" style="font-size: 8px; color: #22C55E; margin-right: 5px;"></i> Çevrimiçi'
        : '<i class="fas fa-circle" style="font-size: 8px; color: #F59E0B; margin-right: 5px;"></i> Yeniden bağlanıyor';
}

function playCriticalBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!criticalAudioCtx) criticalAudioCtx = new AudioContext();
        const ctx = criticalAudioCtx;
        if (ctx.state === "suspended") ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = 880;
        gain.gain.value = 0.08;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => {
            osc.stop();
            osc.disconnect();
            gain.disconnect();
        }, 320);
    } catch (error) {
        console.warn("Uyarı sesi çalınamadı:", error);
    }
}

function showCriticalAlert(description, meta = {}) {
    const alertType = meta.alert_type || "conversation_risk";
    if (!isAlertTypeEnabled(alertType)) return;

    const prefs = getNotifyPrefs();
    const banner = document.getElementById("critical-alert-banner");
    const text = document.getElementById("critical-alert-description");
    const detail = description || "Yakınınız için kritik bir sağlık olayı bildirildi.";
    pendingCriticalAlertId = meta.alert_id || meta.id || null;

    if (prefs.banner !== false && banner && text) {
        text.textContent = detail;
        banner.hidden = false;
    }

    if (prefs.sound !== false) playCriticalBeep();

    const health = document.getElementById("health-status");
    if (health) health.textContent = "Acil dikkat";

    if (meta.prependToList !== false) {
        prependLiveAlertToList({
            id: pendingCriticalAlertId,
            alert_type: alertType,
            severity: meta.severity || "high",
            description: detail,
            status: "open",
            created_at: new Date().toISOString(),
        });
    }
}

async function hideCriticalAlert() {
    const banner = document.getElementById("critical-alert-banner");
    if (banner) banner.hidden = true;
    if (pendingCriticalAlertId) {
        await acknowledgeAlert(pendingCriticalAlertId, { silent: true });
        pendingCriticalAlertId = null;
    }
}

function prependLiveAlertToList(alert) {
    cachedAlerts = [alert, ...cachedAlerts];
    renderMedicationAlerts(cachedAlerts);
    renderAllAlerts(cachedAlerts);
    updateAlertCount(filterAlertsByPrefs(cachedAlerts).length);
}

function alertTypeLabel(alertType) {
    if (alertType === "medication_missed") return "İlaç kaçırıldı";
    if (alertType === "wrong_medication" || alertType === "medication_wrong") return "Yanlış ilaç";
    if (alertType === "conversation_risk") return "Sohbet riski / acil ifade";
    if (alertType === "checkin_missing") return "Check-in eksik";
    if (alertType === "mood_decline") return "Ruh hali düşüşü";
    return "Uyarı";
}

function formatAlertDescription(alert) {
    let desc = String(alert?.description || "").trim();
    if (!desc) return "Açıklama yok.";
    // Eski teknik etiketleri sadeleştir
    desc = desc
        .replace(/Kural tabanlı acil durum kalıbı/gi,
            "Acil durum anahtar kelimesi algılandı (düşme, nefes, yardım vb.)")
        .replace(/Kural tabanlı sağlık\/ilaç kalıbı/gi,
            "Sağlık veya ilaç ifadesi algılandı");
    return desc;
}

function isAlertOpen(alert) {
    if (!alert) return false;
    const desc = String(alert.description || "");
    if (desc.startsWith("[GÖRÜLDÜ]") || desc.startsWith("[ÇÖZÜLDÜ]")) return false;
    const status = String(alert.status || "open").toLowerCase();
    return !status || ["open", "new", "none", "null"].includes(status);
}

function alertStatusLabel(alert) {
    const status = String(alert.status || "open").toLowerCase();
    if (status === "acknowledged" || String(alert.description || "").startsWith("[GÖRÜLDÜ]")) {
        return "Görüldü";
    }
    if (status === "resolved" || status === "closed"
        || String(alert.description || "").startsWith("[ÇÖZÜLDÜ]")) {
        return "Çözüldü";
    }
    return "Açık";
}

function buildAlertCard(alert) {
    const time = alert.created_at
        ? new Date(alert.created_at).toLocaleString("tr-TR")
        : "";
    const severity = alert.severity === "high" ? "is-critical" : "is-warning";
    const open = isAlertOpen(alert);
    const id = alert.id ? String(alert.id) : "";
    const actions = id
        ? `<div class="alert-actions">
            ${open ? `<button type="button" class="btn-secondary btn-xs" onclick="acknowledgeAlert('${escapeHtml(id)}')">Gördüm</button>` : ""}
            ${open || String(alert.status || "").toLowerCase() === "acknowledged"
                ? `<button type="button" class="btn-secondary btn-xs" onclick="resolveAlert('${escapeHtml(id)}')">Çözüldü</button>`
                : ""}
           </div>`
        : "";
    return `
        <div class="alert-card ${severity}${open ? "" : " is-closed"}">
            <div class="alert-card-head">
                <strong>${alertTypeLabel(alert.alert_type)}</strong>
                <span class="alert-status-pill">${alertStatusLabel(alert)}</span>
            </div>
            <p class="alert-desc">${escapeHtml(formatAlertDescription(alert)).replace(/\n/g, "<br>")}</p>
            <div class="alert-meta">${time}${alert.severity === "high" ? " · Öncelik: yüksek" : ""}</div>
            ${actions}
        </div>
    `;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function handleCriticalWsEvent(payload) {
    if (!payload || payload.type !== "CRITICAL_HEALTH_EVENT") return;
    const key = `${payload.alert_type}|${payload.description}|${payload.elder_id || ""}`;
    if (key === lastSeenAlertKey) return;
    lastSeenAlertKey = key;
    showCriticalAlert(payload.description, {
        alert_type: payload.alert_type,
        severity: payload.severity,
    });
}

function connectFamilyWebSocket(elderProfileId) {
    if (!elderProfileId) return;
    if (familyWs && (familyWs.readyState === WebSocket.OPEN || familyWs.readyState === WebSocket.CONNECTING)) {
        return;
    }

    const wsUrl = `${WS_BASE_URL}/ws/client/${elderProfileId}?role=family`;
    try {
        familyWs = new WebSocket(wsUrl);
    } catch (error) {
        console.error("Aile WS açılamadı:", error);
        setLiveConnectionStatus(false);
        scheduleWsReconnect(elderProfileId);
        return;
    }

    familyWs.onopen = () => {
        setLiveConnectionStatus(true);
        if (familyWsReconnectTimer) {
            clearTimeout(familyWsReconnectTimer);
            familyWsReconnectTimer = null;
        }
    };

    familyWs.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            handleCriticalWsEvent(payload);
        } catch (error) {
            console.warn("WS mesajı parse edilemedi:", error);
        }
    };

    familyWs.onclose = () => {
        setLiveConnectionStatus(false);
        scheduleWsReconnect(elderProfileId);
    };

    familyWs.onerror = () => {
        setLiveConnectionStatus(false);
        try { familyWs.close(); } catch (_) { /* ignore */ }
    };
}

function scheduleWsReconnect(elderProfileId) {
    if (familyWsReconnectTimer) return;
    familyWsReconnectTimer = setTimeout(() => {
        familyWsReconnectTimer = null;
        connectFamilyWebSocket(elderProfileId);
    }, 4000);
}

async function pollAlertsFallback(elderProfileId) {
    if (!elderProfileId) return;
    try {
        const openOnly = alertFilterMode === "open";
        const q = openOnly ? "?open_only=true&limit=40" : "?limit=40";
        const alertsRes = await fetch(`${API_BASE_URL}/medication/alerts/${elderProfileId}${q}`);
        const alertsData = await alertsRes.json();
        if (!alertsRes.ok) return;

        cachedAlerts = alertsData.alerts || [];
        if (typeof alertsData.open_count === "number") {
            openAlertCount = alertsData.open_count;
        } else {
            openAlertCount = cachedAlerts.filter(isAlertOpen).length;
        }
        const visible = filterAlertsByPrefs(cachedAlerts);
        renderMedicationAlerts(cachedAlerts);
        renderAllAlerts(cachedAlerts);
        updateAlertCount(openAlertCount);

        const openVisible = visible.filter(isAlertOpen);
        const newest = openVisible[0];
        if (!newest) return;
        const key = `${newest.alert_type}|${newest.description}|${newest.id || newest.created_at}`;
        const isHigh = newest.severity === "high" || newest.alert_type === "checkin_missing";
        const isCriticalType = newest.alert_type === "conversation_risk"
            || newest.alert_type === "medication_missed"
            || newest.alert_type === "checkin_missing"
            || newest.alert_type === "mood_decline";

        if (isHigh && isCriticalType && key !== lastSeenAlertKey) {
            const wsOpen = familyWs && familyWs.readyState === WebSocket.OPEN;
            lastSeenAlertKey = key;
            if (!wsOpen) {
                showCriticalAlert(newest.description, {
                    alert_type: newest.alert_type,
                    severity: newest.severity,
                    alert_id: newest.id,
                    prependToList: false,
                });
            }
        }
    } catch (error) {
        console.warn("Alert poll hatası:", error);
    }
}

function startAlertPolling(elderProfileId) {
    if (alertPollTimer) clearInterval(alertPollTimer);
    pollAlertsFallback(elderProfileId);
    alertPollTimer = setInterval(() => pollAlertsFallback(elderProfileId), ALERT_POLL_MS);
}

async function startFamilyRealtime() {
    const elderlyId = localStorage.getItem("elderly_id");
    const boundUserId = localStorage.getItem("elder_bound_user_id");
    let elderProfileId = null;
    if (
        localStorage.getItem("elder_id") &&
        elderlyId &&
        boundUserId === elderlyId
    ) {
        elderProfileId = localStorage.getItem("elder_id");
    } else {
        elderProfileId = await syncElderForFamily();
    }
    if (!elderProfileId) {
        console.warn("elder_id yok; aile WS başlatılamadı.");
        return;
    }
    connectFamilyWebSocket(elderProfileId);
    startAlertPolling(elderProfileId);
}

async function syncElderForFamily() {
    const elderlyId = localStorage.getItem("elderly_id");
    const elderlyName = localStorage.getItem("elderly_name") || "Yakınınız";
    if (!elderlyId) return null;

    try {
        const response = await fetch(`${API_BASE_URL}/medications/sync-elder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_id: elderlyId, user_name: elderlyName }),
        });
        const data = await response.json();
        if (response.ok && data.elder?.id) {
            localStorage.setItem("elder_id", data.elder.id);
            localStorage.setItem("elder_bound_user_id", elderlyId);
            return data.elder.id;
        }
    } catch (error) {
        console.error("Yaşlı profili eşleştirilemedi:", error);
    }
    return localStorage.getItem("elder_id");
}

async function initFamilyMedications() {
    if (typeof MedicationDefinitions === "undefined") return;

    const elderlyId = localStorage.getItem("elderly_id");
    const elderlyName = localStorage.getItem("elderly_name") || "Yakınınız";

    await MedicationDefinitions.init({
        mode: "family",
        apiBaseUrl: API_BASE_URL,
        todayOnly: false,
        userId: elderlyId,
        userName: elderlyName,
    });
}

function renderWeeklyTrend(weeklyTrend) {
    const container = document.getElementById("weekly-trend-chart");
    if (!container) return;

    if (!weeklyTrend || weeklyTrend.length === 0) {
        container.innerHTML = '<p class="muted">Henüz yeterli ilaç kaydı yok.</p>';
        return;
    }

    container.innerHTML = weeklyTrend.map((day) => {
        const total = (day.taken || 0) + (day.missed || 0) + (day.wrong_medication || 0);
        const rate = total > 0 ? Math.round((day.taken / total) * 100) : 0;
        const dateLabel = new Date(day.date).toLocaleDateString("tr-TR", {
            weekday: "short",
            day: "numeric",
            month: "short",
        });
        return `
            <div class="trend-row">
                <span class="trend-label">${dateLabel}</span>
                <div class="trend-bar-track">
                    <div class="trend-bar-fill" style="width:${rate}%"></div>
                </div>
                <span class="trend-pct">%${rate}</span>
            </div>
        `;
    }).join("");
}

function renderMedicationAlerts(alerts) {
    const panel = document.getElementById("med-alerts-panel");
    const list = document.getElementById("med-alerts-list");
    if (!panel || !list) return;

    const visible = filterAlertsByPrefs(alerts).filter(isAlertOpen);
    if (!visible.length) {
        panel.hidden = true;
        list.innerHTML = "";
        return;
    }

    panel.hidden = false;
    list.innerHTML = visible.slice(0, 5).map((alert) => buildAlertCard(alert)).join("");
}

function renderAllAlerts(alerts) {
    const list = document.getElementById("all-alerts-list");
    if (!list) return;
    let visible = filterAlertsByPrefs(alerts);
    if (alertFilterMode === "open") {
        visible = visible.filter(isAlertOpen);
    }
    const hint = document.getElementById("alert-open-hint");
    if (hint) {
        hint.textContent = `Açık uyarı sayısı: ${openAlertCount}`;
    }
    if (!visible.length) {
        list.innerHTML = alertFilterMode === "open"
            ? '<p class="muted">Açık uyarı yok.</p>'
            : '<p class="muted">Seçili tercihlere göre gösterilecek uyarı yok.</p>';
        return;
    }
    list.innerHTML = visible.map((alert) => buildAlertCard(alert)).join("");
}

function updateAlertCount(count) {
    const el = document.getElementById("alert-count-status");
    if (el) el.textContent = String(count ?? openAlertCount ?? 0);
}

function setAlertFilter(mode) {
    alertFilterMode = mode === "all" ? "all" : "open";
    const openBtn = document.getElementById("alertFilterOpen");
    const allBtn = document.getElementById("alertFilterAll");
    if (openBtn) openBtn.classList.toggle("active", alertFilterMode === "open");
    if (allBtn) allBtn.classList.toggle("active", alertFilterMode === "all");
    refreshAlerts();
}
window.setAlertFilter = setAlertFilter;

async function patchAlertStatus(alertId, status, opts = {}) {
    if (!alertId) return false;
    const familyName = localStorage.getItem("family_name") || "Aile";
    try {
        const res = await fetch(`${API_BASE_URL}/medication/alerts/${encodeURIComponent(alertId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                status,
                acknowledged_by: familyName,
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (!opts.silent) {
                console.warn("Uyarı güncellenemedi:", data.detail || res.status);
            }
            return false;
        }
        const updated = data.alert || { id: alertId, status };
        cachedAlerts = cachedAlerts.map((a) => (
            a.id === alertId ? { ...a, ...updated } : a
        ));
        openAlertCount = cachedAlerts.filter(isAlertOpen).length;
        renderMedicationAlerts(cachedAlerts);
        renderAllAlerts(cachedAlerts);
        updateAlertCount(openAlertCount);
        if (pendingCriticalAlertId === alertId) {
            const banner = document.getElementById("critical-alert-banner");
            if (banner) banner.hidden = true;
            pendingCriticalAlertId = null;
        }
        return true;
    } catch (error) {
        console.warn("Uyarı PATCH hatası:", error);
        return false;
    }
}

async function acknowledgeAlert(alertId, opts = {}) {
    return patchAlertStatus(alertId, "acknowledged", opts);
}
window.acknowledgeAlert = acknowledgeAlert;

async function resolveAlert(alertId, opts = {}) {
    return patchAlertStatus(alertId, "resolved", opts);
}
window.resolveAlert = resolveAlert;

function statusBadgeClass(status) {
    if (status === "Başarılı") return "status-good";
    if (status === "Tehlike") return "status-bad";
    return "status-warn";
}

async function loadEventHistory(elderProfileId) {
    const tbody = document.getElementById("history-table-body");
    if (!tbody || !elderProfileId) return;

    try {
        const response = await fetch(`${API_BASE_URL}/medication/history/${elderProfileId}`);
        const data = await response.json();

        if (!response.ok || !data.events?.length) {
            tbody.innerHTML = '<tr><td colspan="4">Henüz kayıt bulunmuyor.</td></tr>';
            return;
        }

        tbody.innerHTML = data.events.map((event) => {
            const time = event.timestamp
                ? new Date(event.timestamp).toLocaleString("tr-TR")
                : "-";
            const badgeClass = statusBadgeClass(event.status);
            return `
                <tr>
                    <td>${time}</td>
                    <td>${escapeHtml(event.category || "")}</td>
                    <td><span class="status-badge ${badgeClass}">${escapeHtml(event.status || "")}</span></td>
                    <td>${escapeHtml(event.description || "")}</td>
                </tr>
            `;
        }).join("");
    } catch (error) {
        console.error("Geçmiş yüklenemedi:", error);
        tbody.innerHTML = '<tr><td colspan="4">Geçmiş yüklenirken hata oluştu.</td></tr>';
    }
}

function moodScore(mood) {
    const value = String(mood || "").toLocaleLowerCase("tr-TR");
    if (value.includes("harika") || value.includes("çok iyi") || value.includes("iyi") || value === "good") return 3;
    if (value.includes("halsiz") || value.includes("yorgun") || value.includes("kötü") || value === "bad" || value === "tired") return 1;
    return 2;
}

function setFamilyCheckinRange(range) {
    familyCheckinRange = range;
    document.querySelectorAll(".chart-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.range === range);
    });
    renderFamilyCheckinChart(familyCheckinCache, range);
}
window.setFamilyCheckinRange = setFamilyCheckinRange;

function renderFamilyCheckinChart(history, range) {
    const chart = document.getElementById("family-checkin-chart");
    if (!chart) return;
    const now = new Date();
    let buckets = [];

    if (range === "day") {
        buckets = Array.from({ length: 6 }, (_, i) => {
            const start = i * 4;
            return {
                label: `${String(start).padStart(2, "0")}-${String(start + 4).padStart(2, "0")}`,
                items: history.filter((item) => {
                    const d = new Date(item.created_at);
                    return d.toDateString() === now.toDateString()
                        && d.getHours() >= start
                        && d.getHours() < start + 4;
                }),
            };
        });
    } else if (range === "month") {
        buckets = Array.from({ length: 4 }, (_, i) => {
            const start = new Date(now);
            start.setDate(now.getDate() - (3 - i) * 7);
            const end = new Date(start);
            end.setDate(start.getDate() + 7);
            return {
                label: `${i + 1}. hf`,
                items: history.filter((item) => {
                    const d = new Date(item.created_at);
                    return d >= start && d < end;
                }),
            };
        });
    } else {
        buckets = Array.from({ length: 7 }, (_, i) => {
            const day = new Date(now);
            day.setDate(now.getDate() - (6 - i));
            return {
                label: day.toLocaleDateString("tr-TR", { weekday: "short" }),
                items: history.filter((item) =>
                    new Date(item.created_at).toDateString() === day.toDateString()
                ),
            };
        });
    }

    chart.innerHTML = buckets.map((bucket) => {
        const scores = bucket.items.map((item) => moodScore(item.mood));
        const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        const height = scores.length ? Math.max(12, Math.round((avg / 3) * 150)) : 6;
        const color = !scores.length
            ? "#cbd5e1"
            : avg >= 2.5
                ? "linear-gradient(180deg,#34d399,#059669)"
                : avg >= 1.5
                    ? "linear-gradient(180deg,#60a5fa,#2563eb)"
                    : "linear-gradient(180deg,#f87171,#dc2626)";
        return `
            <div class="checkin-bar-col" title="${bucket.items.length} kayıt">
                <div class="checkin-bar" style="height:${height}px;background:${color}"></div>
                <span class="checkin-bar-label">${bucket.label}</span>
            </div>
        `;
    }).join("");
}

async function fetchCheckinHistoryFor(conversationId) {
    if (!conversationId) return [];
    const response = await fetch(
        `${API_BASE_URL}/checkin/history?conversation_id=${encodeURIComponent(conversationId)}&limit=60`
    );
    const data = await response.json();
    return response.ok ? (data.history || []) : [];
}

async function loadFamilyCheckins() {
    const list = document.getElementById("family-checkin-list");
    const elderlyId = localStorage.getItem("elderly_id");
    if (!list || !elderlyId) {
        if (list) list.innerHTML = '<p class="muted">Check-in için yaşlı bağlantısı yok.</p>';
        return;
    }

    try {
        let history = await fetchCheckinHistoryFor(elderlyId);
        if (!history.length) {
            const elderProfileId = localStorage.getItem("elder_id") || await syncElderForFamily();
            if (elderProfileId && elderProfileId !== elderlyId) {
                history = await fetchCheckinHistoryFor(elderProfileId);
            }
        }
        familyCheckinCache = history;

        if (!history.length) {
            list.innerHTML = '<p class="muted">Henüz check-in kaydı yok.</p>';
            renderFamilyCheckinChart([], familyCheckinRange);
            return;
        }

        list.innerHTML = history.map((item) => {
            const date = new Date(item.created_at);
            const dateStr = date.toLocaleDateString("tr-TR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
            });
            const timeStr = date.toLocaleTimeString("tr-TR", {
                hour: "2-digit",
                minute: "2-digit",
            });
            return `
                <div class="checkin-item">
                    <strong>${escapeHtml(translateMood(item.mood))}</strong>
                    <span>${dateStr} · ${timeStr}</span>
                </div>
            `;
        }).join("");

        renderFamilyCheckinChart(history, familyCheckinRange);

        const statusRes = await fetchJson(
            `${API_BASE_URL}/checkin/status?conversation_id=${encodeURIComponent(elderlyId)}`,
            {},
            8000
        );
        if (statusRes.ok && statusRes.data?.last_checkin?.mood) {
            const health = document.getElementById("health-status");
            if (health && (health.textContent === "—" || health.textContent === "Yükleniyor…")) {
                health.textContent = translateMood(statusRes.data.last_checkin.mood);
            }
        }
    } catch (error) {
        console.error("Check-in yüklenemedi:", error);
        list.innerHTML = '<p class="muted">Check-in kayıtları yüklenemedi.</p>';
        renderFamilyCheckinChart([], familyCheckinRange);
    }
}

function displayOrUnknown(value) {
    const text = (value ?? "").toString().trim();
    return text || "Belirtilmemiş";
}

function profileFieldValue(profile, key) {
    const p = profile || {};
    if (key === "full_name") return p.full_name || localStorage.getItem("elderly_name") || "";
    if (key === "weight_kg") return p.weight_kg ?? "";
    if (key === "height_cm") return p.height_cm ?? "";
    if (key === "birth_date") {
        const raw = p.birth_date || "";
        return String(raw).slice(0, 10);
    }
    return p[key] ?? "";
}

function renderFamilyProfileActions() {
    const actions = document.getElementById("familyProfileActions");
    if (!actions) return;
    if (familyProfileEditing) {
        actions.innerHTML = `
            <button type="button" class="btn-primary" onclick="saveFamilyElderProfile()">
                <i class="fas fa-save"></i> Kaydet
            </button>
            <button type="button" class="btn-secondary" onclick="toggleFamilyProfileEdit(false)">İptal</button>
        `;
        return;
    }
    actions.innerHTML = `
        <button type="button" class="btn-primary" id="familyProfileEditToggle" onclick="toggleFamilyProfileEdit()">
            <i class="fas fa-pen"></i> Düzenle
        </button>
    `;
}

function renderFamilyProfileView(profile, editing = familyProfileEditing) {
    const view = document.getElementById("family-profile-view");
    if (!view) return;
    const p = profile || {};
    view.classList.toggle("is-editing", editing);

    if (!editing) {
        view.innerHTML = `
            <div class="profile-field"><span>Ad soyad</span><strong>${escapeHtml(displayOrUnknown(p.full_name))}</strong></div>
            <div class="profile-field"><span>Doğum tarihi</span><strong>${escapeHtml(displayOrUnknown(p.birth_date))}</strong></div>
            <div class="profile-field"><span>Telefon</span><strong>${escapeHtml(displayOrUnknown(p.phone))}</strong></div>
            <div class="profile-field"><span>E-posta</span><strong>${escapeHtml(displayOrUnknown(p.email))}</strong></div>
            <div class="profile-field span-2"><span>Kronik / teşhisli hastalıklar</span><strong>${escapeHtml(displayOrUnknown(p.conditions))}</strong></div>
            <div class="profile-field span-2"><span>Alerjiler</span><strong>${escapeHtml(displayOrUnknown(p.allergies))}</strong></div>
            <div class="profile-field"><span>Kilo</span><strong>${escapeHtml(p.weight_kg != null && p.weight_kg !== "" ? `${p.weight_kg} kg` : "Belirtilmemiş")}</strong></div>
            <div class="profile-field"><span>Boy</span><strong>${escapeHtml(p.height_cm != null && p.height_cm !== "" ? `${p.height_cm} cm` : "Belirtilmemiş")}</strong></div>
            <div class="profile-field"><span>Acil durum kişisi</span><strong>${escapeHtml(displayOrUnknown(p.emergency_name))}</strong></div>
            <div class="profile-field"><span>Acil durum telefonu</span><strong>${escapeHtml(displayOrUnknown(p.emergency_phone))}</strong></div>
            <div class="profile-field span-2"><span>Ek notlar</span><strong>${escapeHtml(displayOrUnknown(p.notes))}</strong></div>
        `;
        return;
    }

    view.innerHTML = `
        <div class="profile-field"><span>Ad soyad</span><input id="fpName" type="text" value="${escapeHtml(profileFieldValue(p, "full_name"))}"></div>
        <div class="profile-field"><span>Doğum tarihi</span><input id="fpBirthDate" type="date" value="${escapeHtml(String(profileFieldValue(p, "birth_date") || ""))}"></div>
        <div class="profile-field"><span>Telefon</span><input id="fpPhone" type="tel" value="${escapeHtml(String(profileFieldValue(p, "phone") || ""))}"></div>
        <div class="profile-field"><span>E-posta</span><input id="fpEmail" type="email" value="${escapeHtml(String(profileFieldValue(p, "email") || ""))}"></div>
        <div class="profile-field span-2"><span>Kronik / teşhisli hastalıklar</span><textarea id="fpConditions" rows="2">${escapeHtml(String(profileFieldValue(p, "conditions") || ""))}</textarea></div>
        <div class="profile-field span-2"><span>Alerjiler</span><textarea id="fpAllergies" rows="2">${escapeHtml(String(profileFieldValue(p, "allergies") || ""))}</textarea></div>
        <div class="profile-field"><span>Kilo (kg)</span><input id="fpWeight" type="number" step="0.1" value="${escapeHtml(String(profileFieldValue(p, "weight_kg") ?? ""))}"></div>
        <div class="profile-field"><span>Boy (cm)</span><input id="fpHeight" type="number" value="${escapeHtml(String(profileFieldValue(p, "height_cm") ?? ""))}"></div>
        <div class="profile-field"><span>Acil durum kişisi</span><input id="fpEmergencyName" type="text" value="${escapeHtml(String(profileFieldValue(p, "emergency_name") || ""))}"></div>
        <div class="profile-field"><span>Acil durum telefonu</span><input id="fpEmergencyPhone" type="tel" value="${escapeHtml(String(profileFieldValue(p, "emergency_phone") || ""))}"></div>
        <div class="profile-field span-2"><span>Ek notlar</span><textarea id="fpNotes" rows="2">${escapeHtml(String(profileFieldValue(p, "notes") || ""))}</textarea></div>
    `;
}

async function loadFamilyElderProfile() {
    const elderlyId = localStorage.getItem("elderly_id");
    if (!elderlyId) return;

    try {
        const response = await fetch(`${API_BASE_URL}/elder-profile/${elderlyId}`);
        const data = await response.json();
        familyProfileCache = data.profile || { user_id: elderlyId };
        familyProfileEditing = false;
        renderFamilyProfileView(familyProfileCache, false);
        renderFamilyProfileActions();
        const status = document.getElementById("fpStatus");
        if (status) status.textContent = "";
    } catch (error) {
        console.error("Profil yüklenemedi:", error);
        familyProfileCache = { user_id: elderlyId };
        familyProfileEditing = false;
        renderFamilyProfileView(familyProfileCache, false);
        renderFamilyProfileActions();
    }
}

function toggleFamilyProfileEdit(forceOpen) {
    const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !familyProfileEditing;
    familyProfileEditing = shouldOpen;
    renderFamilyProfileView(familyProfileCache, familyProfileEditing);
    renderFamilyProfileActions();
    const status = document.getElementById("fpStatus");
    if (status && !shouldOpen) status.textContent = "";
}
window.toggleFamilyProfileEdit = toggleFamilyProfileEdit;

async function saveFamilyElderProfile() {
    const elderlyId = localStorage.getItem("elderly_id");
    const status = document.getElementById("fpStatus");
    if (!elderlyId) return;

    const payload = {
        full_name: document.getElementById("fpName")?.value?.trim() || null,
        birth_date: document.getElementById("fpBirthDate")?.value || null,
        phone: document.getElementById("fpPhone")?.value?.trim() || null,
        email: document.getElementById("fpEmail")?.value?.trim() || null,
        conditions: document.getElementById("fpConditions")?.value?.trim() || null,
        allergies: document.getElementById("fpAllergies")?.value?.trim() || null,
        weight_kg: document.getElementById("fpWeight")?.value || null,
        height_cm: document.getElementById("fpHeight")?.value || null,
        emergency_name: document.getElementById("fpEmergencyName")?.value?.trim() || null,
        emergency_phone: document.getElementById("fpEmergencyPhone")?.value?.trim() || null,
        notes: document.getElementById("fpNotes")?.value?.trim() || null,
    };

    if (status) status.textContent = "Kaydediliyor…";

    try {
        const response = await fetch(`${API_BASE_URL}/elder-profile/${elderlyId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(typeof data.detail === "string" ? data.detail : "Kayıt başarısız");
        }

        if (payload.full_name) {
            localStorage.setItem("elderly_name", payload.full_name);
            const title = document.getElementById("elderly-title");
            if (title) title.textContent = `Takip Edilen: ${payload.full_name}`;
        }

        // Veritabanındaki güncel kaydı tekrar çek
        const reload = await fetch(`${API_BASE_URL}/elder-profile/${elderlyId}`);
        const reloadData = await reload.json();
        familyProfileCache = reloadData.profile || data.profile || { ...familyProfileCache, ...payload, user_id: elderlyId };
        familyProfileEditing = false;
        renderFamilyProfileView(familyProfileCache, false);
        renderFamilyProfileActions();
        if (status) status.textContent = "Profil veritabanına kaydedildi.";
    } catch (error) {
        console.error(error);
        if (status) status.textContent = error.message || "Kaydedilemedi. Lütfen tekrar deneyin.";
    }
}
window.saveFamilyElderProfile = saveFamilyElderProfile;

async function refreshAlerts() {
    const elderProfileId = localStorage.getItem("elder_id") || await syncElderForFamily();
    if (elderProfileId) await pollAlertsFallback(elderProfileId);
}
window.refreshAlerts = refreshAlerts;

function initNotifyPrefs() {
    const prefs = loadNotifyPrefs();
    // Eski varsayılan sms:false idi — bir kez açık hale getir
    if (localStorage.getItem("family_sms_pref_v2") !== "1") {
        prefs.sms = true;
        saveNotifyPrefs(prefs);
        localStorage.setItem("family_sms_pref_v2", "1");
    }
    if (prefs.sms == null) prefs.sms = true;

    document.querySelectorAll("[data-pref]").forEach((input) => {
        const key = input.getAttribute("data-pref");
        if (!key) return;
        if (key === "sms") input.checked = prefs.sms !== false;
        else input.checked = prefs[key] !== false;

        input.addEventListener("change", () => {
            const next = loadNotifyPrefs();
            next[key] = input.checked;
            saveNotifyPrefs(next);
            const status = document.getElementById("notifyPrefsStatus");
            if (status) status.textContent = "Bildirim tercihleri kaydedildi.";
            if (key === "sms") {
                persistSmsEnabledToServer(input.checked).catch(() => {});
            }
            renderMedicationAlerts(cachedAlerts);
            renderAllAlerts(cachedAlerts);
            updateAlertCount(openAlertCount || filterAlertsByPrefs(cachedAlerts).filter(isAlertOpen).length);
        });
    });

    // Sunucuda SMS tercihini açık tut (telefon profilde zaten var)
    persistSmsEnabledToServer(prefs.sms !== false).catch(() => {});
}

async function persistSmsEnabledToServer(smsEnabled) {
    const elderlyId = localStorage.getItem("elderly_id");
    if (!elderlyId) return;
    try {
        await fetch(`${API_BASE_URL}/family/sms-prefs`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: elderlyId,
                sms_enabled: Boolean(smsEnabled),
            }),
        });
    } catch (_) { /* sessiz */ }
}

async function fetchDashboardData() {
    const elderlyId = localStorage.getItem("elderly_id");
    const elderlyName = localStorage.getItem("elderly_name") || "Yakınınız";
    if (!elderlyId) {
        showDashboardBanner("elderly_id yok — aile girişi gerekli.");
        return;
    }

    const elderProfileId = await syncElderForFamily();

    const summaryRes = await fetchJson(
        `${API_BASE_URL}/family/dashboard-summary/${encodeURIComponent(elderlyId)}`,
        {},
        15000
    );

    if (summaryRes.ok && summaryRes.data?.success) {
        const data = summaryRes.data;
        const health = document.getElementById("health-status");
        const activity = document.getElementById("activity-status");
        const activityHint = document.getElementById("activity-hint");
        const heroTitle = document.getElementById("status-hero-title");
        const heroLine = document.getElementById("status-hero-line");
        const heroMood = document.getElementById("status-hero-mood");

        const moodLabel = data.mood?.label || translateMood(data.latest_mood);
        if (health) health.textContent = moodLabel;
        if (activity) activity.textContent = data.activity_status || "Henüz etkileşim yok";
        if (activityHint) {
            activityHint.textContent = "Sohbet / check-in / ilaç etkileşimi (fiziksel hareket değil)";
        }
        if (heroTitle) heroTitle.textContent = `${elderlyName} — Genel Durum`;
        if (heroLine) heroLine.textContent = data.status_line || moodLabel;
        if (heroMood) {
            heroMood.textContent = moodLabel;
            heroMood.className = `status-hero-mood tone-${data.mood?.tone || "unknown"}`;
        }
        if (data.medication_status) {
            const pill = document.getElementById("pill-status");
            if (pill) pill.textContent = data.medication_status;
        }
        if (data.medication_stats?.weekly_trend) {
            renderWeeklyTrend(data.medication_stats.weekly_trend);
        } else {
            renderWeeklyTrend([]);
        }
        if (Array.isArray(data.recent_alerts)) {
            cachedAlerts = data.recent_alerts;
            if (typeof data.open_alert_count === "number") {
                openAlertCount = data.open_alert_count;
            } else {
                openAlertCount = cachedAlerts.filter(isAlertOpen).length;
            }
            renderMedicationAlerts(cachedAlerts);
            renderAllAlerts(cachedAlerts);
            updateAlertCount(openAlertCount);
        }
    } else {
        const heroLine = document.getElementById("status-hero-line");
        if (heroLine) {
            heroLine.textContent = `Özet alınamadı (${summaryRes.data?.detail || summaryRes.status}). Diğer kartlar yüklenmeye devam ediyor.`;
        }
        renderWeeklyTrend([]);
        const alertsList = document.getElementById("all-alerts-list");
        if (alertsList && !cachedAlerts.length) {
            alertsList.innerHTML = '<p class="muted">Uyarı listesi şu an boş veya erişilemedi.</p>';
        }
    }

    if (elderProfileId) {
        const statsRes = await fetchJson(
            `${API_BASE_URL}/medication/stats/${elderProfileId}`,
            {},
            12000
        );
        if (statsRes.ok) {
            const stats = statsRes.data || {};
            const rate = stats.adherence_rate ?? 0;
            const pill = document.getElementById("pill-status");
            if (pill) {
                pill.textContent = stats.total_logs > 0 ? `%${rate} uyum` : "Henüz kayıt yok";
            }
            renderWeeklyTrend(stats.weekly_trend || []);
        }

        const alertsRes = await fetchJson(
            `${API_BASE_URL}/medication/alerts/${elderProfileId}?open_only=true&limit=40`,
            {},
            10000
        );
        if (alertsRes.ok) {
            cachedAlerts = alertsRes.data?.alerts || [];
            if (typeof alertsRes.data?.open_count === "number") {
                openAlertCount = alertsRes.data.open_count;
            } else {
                openAlertCount = cachedAlerts.filter(isAlertOpen).length;
            }
            renderMedicationAlerts(cachedAlerts);
            renderAllAlerts(cachedAlerts);
            updateAlertCount(openAlertCount);
        }

        loadEventHistory(elderProfileId).catch(() => {});
        loadAdherencePanel().catch(() => {});
    }

    // AI özeti asla paneli bloklamasın
    loadAiSummary(elderlyId).catch(() => {});
}

async function loadAiSummary(elderlyId) {
    const aiBox = document.getElementById("ai-summary");
    if (!aiBox || !elderlyId) return;
    aiBox.textContent = "Son 7 gün analiz ediliyor…";
    const aiRes = await fetchJson(
        `${API_BASE_URL}/family/generate-ai-summary`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation_id: elderlyId, days: 7 }),
        },
        45000
    );
    if (aiRes.ok && aiRes.data?.success && aiRes.data.summary) {
        aiBox.textContent = aiRes.data.summary;
    } else {
        aiBox.textContent = "AI özeti şu an yok. İlaç / check-in kartlarından durumu takip edin.";
    }
}

function translateMood(mood) {
    if (!mood) return "—";
    const raw = String(mood).trim();
    const folded = raw
        .toLocaleLowerCase("tr-TR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const map = {
        good: "İyi",
        bad: "Kötü",
        normal: "Normal",
        tired: "Halsiz / yorgun",
        great: "Harika",
        okay: "Normal",
        "veri yok": "Veri yok",
    };
    if (map[folded]) return map[folded];
    if (map[raw]) return map[raw];

    if (folded.includes("harika") || folded.includes("cok iyi")) return "Harika";
    if (folded.includes("halsiz") || folded.includes("yorgun")) return "Halsiz / yorgun";
    if (folded.includes("kotu") || folded.includes("kötü")) return "Kötü";
    if (folded.includes("iyi") || folded.includes("guzel")) return "İyi";
    if (folded.includes("normal") || folded.includes("orta")) return "Normal";

    // Zaten Türkçe okunabilir etiket geldiyse olduğu gibi bırak
    if (/[çğıöşüÇĞİÖŞÜa-zA-Z]/.test(raw) && raw.length < 40) return raw;
    return raw;
}

function renderMoodDayChart(containerId, series) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!series || !series.length) {
        el.innerHTML = '<p class="muted">Henüz yeterli kayıt yok.</p>';
        return;
    }
    el.innerHTML = series.map((day) => {
        const score = day.avg_score;
        const height = score == null ? 8 : Math.max(14, Math.round((score / 3) * 120));
        const tone = day.tone || "unknown";
        const dateLabel = new Date(day.date + "T12:00:00").toLocaleDateString("tr-TR", {
            weekday: "short",
            day: "numeric",
        });
        return `
            <div class="mood-day-col" title="${escapeHtml(day.label || "")}">
                <div class="mood-day-bar tone-${tone}" style="height:${height}px"></div>
                <span>${dateLabel}</span>
            </div>
        `;
    }).join("");
}

async function loadWeeklySummary() {
    const elderlyId = localStorage.getItem("elderly_id");
    const bullets = document.getElementById("weekly-bullets");
    if (!elderlyId) {
        if (bullets) bullets.innerHTML = '<li class="muted">elderly_id yok.</li>';
        return;
    }

    try {
        if (bullets) bullets.innerHTML = '<li class="muted">Haftalık özet yenileniyor…</li>';
        const res = await fetchJson(
            `${API_BASE_URL}/family/weekly-summary/${encodeURIComponent(elderlyId)}`,
            {},
            25000
        );
        const data = res.data || {};
        if (!res.ok || data.success === false) {
            throw new Error(data.detail || data.error || "Haftalık özet alınamadı");
        }

        if (bullets) {
            bullets.innerHTML = (data.bullets || [])
                .map((b) => `<li>${escapeHtml(b)}</li>`)
                .join("") || '<li class="muted">Veri yok</li>';
        }

        const moodAvg = document.getElementById("weekly-mood-avg");
        const medRate = document.getElementById("weekly-med-rate");
        const alertCount = document.getElementById("weekly-alert-count");
        const chatTone = document.getElementById("weekly-chat-tone");

        if (moodAvg) {
            moodAvg.textContent = data.mood?.week_avg_score != null
                ? `${data.mood.week_avg_score}/3`
                : "Veri yok";
        }
        if (medRate) {
            const total = data.medication?.total_logs || 0;
            medRate.textContent = total
                ? `%${data.medication.adherence_rate}`
                : "Henüz kayıt yok";
        }
        if (alertCount) alertCount.textContent = String(data.alerts?.week_count ?? 0);
        if (chatTone) {
            const label = data.mood?.chat_label || "—";
            chatTone.textContent = label.charAt(0).toUpperCase() + label.slice(1);
        }

        renderMoodDayChart("weekly-mood-chart", data.mood?.series || []);
        // Yenile aynı anda AI özetini de tazelesin
        loadAiSummary(elderlyId).catch(() => {});
    } catch (error) {
        console.error(error);
        if (bullets) {
            bullets.innerHTML = `<li class="muted">${escapeHtml(error.message || "Haftalık özet yüklenemedi")}</li>`;
        }
        renderMoodDayChart("weekly-mood-chart", []);
    }
}
window.loadWeeklySummary = loadWeeklySummary;

async function loadMoodAnalysis() {
    const elderlyId = localStorage.getItem("elderly_id");
    const insight = document.getElementById("mood-insight");
    if (!elderlyId) {
        if (insight) insight.textContent = "elderly_id yok.";
        return;
    }

    try {
        const res = await fetchJson(
            `${API_BASE_URL}/family/mood-analysis/${encodeURIComponent(elderlyId)}`,
            {},
            18000
        );
        const data = res.data || {};
        if (!res.ok || data.success === false) {
            throw new Error(data.detail || "Analiz alınamadı");
        }

        if (insight) insight.textContent = data.insight || "—";

        const declineBanner = document.getElementById("mood-decline-banner");
        const declineText = document.getElementById("mood-decline-text");
        if (declineBanner && declineText) {
            if (data.decline?.triggered) {
                declineBanner.hidden = false;
                declineText.textContent = data.decline.description || "Ruh hali düşüşü tespit edildi.";
            } else {
                declineBanner.hidden = true;
            }
        }

        renderMoodDayChart("mood-checkin-chart", data.checkin_series || []);

        const fill = document.getElementById("sentiment-fill");
        const sentLabel = document.getElementById("sentiment-label");
        const chat = data.chat_sentiment || {};
        const score = Number(chat.score || 0);
        const pct = Math.round(((score + 1) / 2) * 100);
        if (fill) {
            fill.style.width = `${pct}%`;
            fill.className = `sentiment-fill tone-${
                score >= 0.25 ? "good" : score <= -0.25 ? "bad" : "neutral"
            }`;
        }
        if (sentLabel) {
            sentLabel.textContent = chat.sample_count
                ? `${chat.label} · ${chat.sample_count} mesaj · risk: ${chat.risk_count || 0}`
                : "Sohbet verisi yok";
        }

        const highlights = document.getElementById("mood-highlights");
        if (highlights) {
            const items = chat.highlights || [];
            if (!items.length) {
                highlights.innerHTML = '<p class="muted">Olumsuz / riskli mesaj örneği yok.</p>';
            } else {
                highlights.innerHTML = items.map((h) => `
                    <div class="mood-highlight ${h.risk ? "is-risk" : ""}">
                        <strong>${h.risk ? "Risk" : escapeHtml(h.label)}</strong>
                        <p>${escapeHtml(h.text || "")}</p>
                    </div>
                `).join("");
            }
        }

        const meta = document.getElementById("mood-latest-meta");
        if (meta && data.latest) {
            meta.textContent = `Son etiket: ${data.latest.label} (ham: ${data.latest.raw || "—"})`;
        }
    } catch (error) {
        console.error(error);
        if (insight) insight.textContent = error.message || "Ruh hali analizi yüklenemedi.";
        renderMoodDayChart("mood-checkin-chart", []);
    }
}
window.loadMoodAnalysis = loadMoodAnalysis;

function toggleSideNav(forceOpen) {
    const rail = document.getElementById("sideNavRail");
    const btn = document.getElementById("navToggleBtn");
    if (!rail) return;

    const isCollapsed = rail.classList.contains("is-collapsed");
    const willExpand = typeof forceOpen === "boolean" ? forceOpen : isCollapsed;
    rail.classList.toggle("is-collapsed", !willExpand);
    if (btn) {
        btn.setAttribute("aria-expanded", willExpand ? "true" : "false");
        btn.title = willExpand ? "Menüyü daralt" : "Menüyü genişlet";
    }
}
window.toggleSideNav = toggleSideNav;

async function loadFamilyChatTranscript(todayOnly) {
    const box = document.getElementById("family-chat-transcript");
    const elderlyId = localStorage.getItem("elderly_id");
    if (!box || !elderlyId) return;

    if (typeof todayOnly !== "boolean") {
        todayOnly = localStorage.getItem("family_chat_today_only") !== "0";
    } else {
        localStorage.setItem("family_chat_today_only", todayOnly ? "1" : "0");
    }

    document.getElementById("chatTodayBtn")?.classList.toggle("is-active", todayOnly);
    document.getElementById("chatAllBtn")?.classList.toggle("is-active", !todayOnly);

    box.innerHTML = '<p class="muted">Sohbet yükleniyor…</p>';
    loadRiskHistoryStrip().catch(() => {});

    try {
        const response = await fetch(
            `${API_BASE_URL}/family/chat-transcript/${encodeURIComponent(elderlyId)}?limit=50&today_only=${todayOnly}`
        );
        const data = await response.json();
        const messages = data.messages || [];

        if (!response.ok) {
            box.innerHTML = '<p class="muted">Sohbet yüklenemedi.</p>';
            return;
        }
        if (!messages.length) {
            box.innerHTML = todayOnly
                ? '<p class="muted">Bugün henüz sohbet yok.</p>'
                : '<p class="muted">Henüz sohbet kaydı yok.</p>';
            return;
        }

        box.innerHTML = messages.map((msg) => {
            const role = (msg.role || "").toLowerCase();
            const isUser = role === "user";
            const label = isUser ? "Yaşlı" : "Refakatçi";
            const time = msg.created_at
                ? new Date(msg.created_at).toLocaleString("tr-TR")
                : "";
            const risk = msg.risk || {};
            const isRisk = Boolean(msg.is_risk);
            const riskBadge = isRisk
                ? `<span class="risk-badge level-${escapeHtml(risk.level || "high")}">Risk ${risk.score ?? "—"}</span>`
                : (isUser && risk.score != null
                    ? `<span class="risk-badge level-low">Skor ${risk.score}</span>`
                    : "");
            return `
                <div class="chat-bubble ${isUser ? "is-user" : "is-assistant"}${isRisk ? " is-risk" : ""}">
                    <span class="chat-role">${label}${riskBadge}</span>
                    <p class="chat-text">${escapeHtml(msg.content || "")}</p>
                    <span class="chat-time">${time}</span>
                </div>
            `;
        }).join("");
        box.scrollTop = box.scrollHeight;
    } catch (error) {
        console.error(error);
        box.innerHTML = '<p class="muted">Sohbet yüklenirken hata oluştu.</p>';
    }
}
window.loadFamilyChatTranscript = loadFamilyChatTranscript;

async function loadRiskHistoryStrip() {
    const strip = document.getElementById("risk-history-strip");
    const elderlyId = localStorage.getItem("elderly_id");
    if (!strip || !elderlyId) return;
    try {
        const res = await fetch(
            `${API_BASE_URL}/family/risk-history/${encodeURIComponent(elderlyId)}?days=14`
        );
        const data = await res.json();
        if (!res.ok || !data.success) {
            strip.innerHTML = '<span class="muted">Risk geçmişi alınamadı.</span>';
            return;
        }
        const avg = data.avg_score != null ? data.avg_score : "—";
        const high = data.high_count ?? 0;
        const samples = data.sample_count ?? 0;
        const alertN = (data.alerts || []).length;
        strip.innerHTML = `
            <strong>14 gün risk özeti</strong>
            <span>Ort. skor: <b>${avg}</b></span>
            <span>Yüksek: <b>${high}</b></span>
            <span>Kayıt: <b>${samples}</b></span>
            <span>Eskalasyon uyarısı: <b>${alertN}</b></span>
        `;
    } catch (error) {
        strip.innerHTML = '<span class="muted">Risk geçmişi yüklenemedi.</span>';
    }
}

function switchDashboardTab(tabName) {
    document.querySelectorAll(".dashboard-section").forEach((sec) => sec.classList.remove("active"));
    document.querySelectorAll(".sidebar-menu li[data-tab]").forEach((li) => li.classList.remove("active"));

    const section = document.getElementById(`sec-${tabName}`);
    if (section) section.classList.add("active");

    const navItem = document.querySelector(`.sidebar-menu li[data-tab="${tabName}"]`);
    if (navItem) navItem.classList.add("active");

    if (tabName === "history") {
        syncElderForFamily().then((id) => { if (id) loadEventHistory(id); });
    } else if (tabName === "medications") {
        initFamilyMedications();
    } else if (tabName === "checkin") {
        loadFamilyCheckins();
    } else if (tabName === "chat") {
        loadFamilyChatTranscript();
    } else if (tabName === "profile") {
        loadFamilyElderProfile();
    } else if (tabName === "alerts") {
        refreshAlerts();
    } else if (tabName === "adherence") {
        loadAdherencePanel();
    } else if (tabName === "weekly") {
        loadWeeklySummary();
    } else if (tabName === "mood") {
        loadMoodAnalysis();
    }
}
window.switchDashboardTab = switchDashboardTab;

function setAdherenceDays(days) {
    adherenceDays = days === 30 ? 30 : 7;
    document.querySelectorAll("#adherenceRangeTabs .chart-tab[data-days]").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.getAttribute("data-days")) === adherenceDays);
    });
    loadAdherencePanel();
}
window.setAdherenceDays = setAdherenceDays;

async function loadAdherencePanel() {
    const elderProfileId = localStorage.getItem("elder_id") || await syncElderForFamily();
    const list = document.getElementById("adh-med-list");
    const overall = document.getElementById("adh-overall");
    const takenEl = document.getElementById("adh-taken");
    const missedEl = document.getElementById("adh-missed");
    const snoozedEl = document.getElementById("adh-snoozed");
    const banner = document.getElementById("adh-target-banner");
    const trend = document.getElementById("adh-trend-chart");

    if (!elderProfileId) {
        if (list) list.innerHTML = '<p class="muted">Yaşlı profili bulunamadı.</p>';
        return;
    }

    try {
        const res = await fetch(
            `${API_BASE_URL}/medication/stats/${elderProfileId}?days=${adherenceDays}`
        );
        const stats = await res.json();
        if (!res.ok) throw new Error(stats.detail || "İstatistik alınamadı");

        const rate = stats.adherence_rate ?? 0;
        const target = stats.target_rate ?? 80;
        if (overall) overall.textContent = stats.total_logs > 0 ? `%${rate}` : "—";
        if (takenEl) takenEl.textContent = String(stats.taken ?? 0);
        if (missedEl) missedEl.textContent = String(stats.missed ?? 0);
        if (snoozedEl) snoozedEl.textContent = String(stats.snoozed ?? 0);

        if (banner) {
            if (!stats.total_logs) {
                banner.textContent = `${adherenceDays} günde henüz alınmış/kaçırılmış doz kaydı yok.`;
                banner.className = "insight-banner";
            } else if (rate >= target) {
                banner.textContent = `Hedef tuttu: %${rate} ≥ hedef %${target} (${adherenceDays} gün).`;
                banner.className = "insight-banner is-good";
            } else {
                banner.textContent = `Hedefin altında: %${rate} < hedef %${target} (${adherenceDays} gün).`;
                banner.className = "insight-banner is-warn";
            }
        }

        const byMed = stats.by_medication || [];
        if (list) {
            if (!byMed.length) {
                list.innerHTML = '<p class="muted">Bu dönemde ilaç bazlı kayıt yok.</p>';
            } else {
                list.innerHTML = byMed.map((m) => {
                    const medRate = m.adherence_rate ?? 0;
                    const tone = medRate >= target ? "is-good" : (medRate >= target - 20 ? "is-warn" : "is-bad");
                    return `
                        <div class="adh-med-row ${tone}">
                            <div class="adh-med-top">
                                <strong>${escapeHtml(m.name || "İlaç")}</strong>
                                <span class="adh-med-rate">%${medRate}</span>
                            </div>
                            <div class="adh-med-bar"><span style="width:${Math.min(100, medRate)}%"></span></div>
                            <div class="adh-med-meta">
                                Alınan ${m.taken ?? 0} · Kaçırılan ${m.missed ?? 0}
                                · Ertelenen ${m.snoozed ?? 0}
                                ${m.wrong ? ` · Yanlış ${m.wrong}` : ""}
                            </div>
                        </div>
                    `;
                }).join("");
            }
        }

        if (trend) {
            const rows = stats.weekly_trend || [];
            if (!rows.length) {
                trend.innerHTML = '<p class="muted">Trend için yeterli veri yok.</p>';
            } else {
                trend.innerHTML = rows.map((day) => {
                    const total = (day.taken || 0) + (day.missed || 0) + (day.wrong_medication || 0);
                    const dayRate = total > 0 ? Math.round((day.taken / total) * 100) : 0;
                    const dateLabel = new Date(day.date).toLocaleDateString("tr-TR", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                    });
                    return `
                        <div class="trend-row">
                            <span class="trend-label">${dateLabel}</span>
                            <div class="trend-bar-track">
                                <div class="trend-bar-fill" style="width:${dayRate}%"></div>
                            </div>
                            <span class="trend-pct">%${dayRate}</span>
                        </div>
                    `;
                }).join("");
            }
        }
    } catch (error) {
        console.error(error);
        if (list) list.innerHTML = `<p class="muted">${escapeHtml(error.message || "Uyumluluk yüklenemedi.")}</p>`;
    }
}
window.loadAdherencePanel = loadAdherencePanel;

function handleLogout() {
    if (familyWs) {
        try { familyWs.close(); } catch (_) { /* ignore */ }
    }
    if (alertPollTimer) clearInterval(alertPollTimer);
    if (familyWsReconnectTimer) clearTimeout(familyWsReconnectTimer);
    localStorage.clear();
    alert("Oturum kapatıldı.");
    window.location.href = "login.html";
}
window.handleLogout = handleLogout;
