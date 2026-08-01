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
let familyProfileCache = null;
let familyProfileEditing = false;

const DEFAULT_NOTIFY_PREFS = {
    critical: true,
    medication_missed: true,
    wrong_medication: true,
    checkin_missing: true,
    sound: true,
    banner: true,
    sms: false,
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

    document.getElementById("welcome-family").textContent = `Hoş geldiniz, ${familyName}`;
    document.getElementById("elderly-title").textContent = `Takip Edilen: ${elderlyName}`;

    const dismissBtn = document.getElementById("critical-alert-dismiss");
    if (dismissBtn) dismissBtn.addEventListener("click", hideCriticalAlert);

    initNotifyPrefs();

    fetchDashboardData().then(() => {
        startFamilyRealtime();
        loadFamilyCheckins();
        loadFamilyElderProfile();
    });
});

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

    if (prefs.banner !== false && banner && text) {
        text.textContent = detail;
        banner.hidden = false;
    }

    if (prefs.sound !== false) playCriticalBeep();

    const health = document.getElementById("health-status");
    if (health) health.textContent = "Acil dikkat";

    if (meta.prependToList !== false) {
        prependLiveAlertToList({
            alert_type: alertType,
            severity: meta.severity || "high",
            description: detail,
            created_at: new Date().toISOString(),
        });
    }
}

function hideCriticalAlert() {
    const banner = document.getElementById("critical-alert-banner");
    if (banner) banner.hidden = true;
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
    if (alertType === "conversation_risk") return "Sağlık riski";
    if (alertType === "checkin_missing") return "Check-in eksik";
    return "Uyarı";
}

function buildAlertCard(alert) {
    const time = alert.created_at
        ? new Date(alert.created_at).toLocaleString("tr-TR")
        : "";
    const severity = alert.severity === "high" ? "is-critical" : "is-warning";
    return `
        <div class="alert-card ${severity}">
            <strong>${alertTypeLabel(alert.alert_type)}</strong>
            <p>${escapeHtml(alert.description || "")}</p>
            <div class="alert-meta">${time}</div>
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
        const alertsRes = await fetch(`${API_BASE_URL}/medication/alerts/${elderProfileId}`);
        const alertsData = await alertsRes.json();
        if (!alertsRes.ok || !alertsData.alerts?.length) return;

        cachedAlerts = alertsData.alerts || [];
        const visible = filterAlertsByPrefs(cachedAlerts);
        renderMedicationAlerts(cachedAlerts);
        renderAllAlerts(cachedAlerts);
        updateAlertCount(visible.length);

        const newest = visible[0];
        if (!newest) return;
        const key = `${newest.alert_type}|${newest.description}|${newest.id || newest.created_at}`;
        const isHigh = newest.severity === "high" || newest.alert_type === "checkin_missing";
        const isCriticalType = newest.alert_type === "conversation_risk"
            || newest.alert_type === "medication_missed"
            || newest.alert_type === "checkin_missing";

        if (isHigh && isCriticalType && key !== lastSeenAlertKey) {
            const wsOpen = familyWs && familyWs.readyState === WebSocket.OPEN;
            if (!wsOpen) {
                lastSeenAlertKey = key;
                showCriticalAlert(newest.description, {
                    alert_type: newest.alert_type,
                    severity: newest.severity,
                    prependToList: false,
                });
            } else {
                lastSeenAlertKey = key;
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

    const visible = filterAlertsByPrefs(alerts);
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
    const visible = filterAlertsByPrefs(alerts);
    if (!visible.length) {
        list.innerHTML = '<p class="muted">Seçili tercihlere göre gösterilecek uyarı yok.</p>';
        return;
    }
    list.innerHTML = visible.map((alert) => buildAlertCard(alert)).join("");
}

function updateAlertCount(count) {
    const el = document.getElementById("alert-count-status");
    if (el) el.textContent = String(count || 0);
}

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
    if (!list || !elderlyId) return;

    try {
        let history = await fetchCheckinHistoryFor(elderlyId);
        // Eski kayıtlarda conversation_id = elder_id olabilir
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

        const statusRes = await fetch(
            `${API_BASE_URL}/checkin/status?conversation_id=${encodeURIComponent(elderlyId)}`
        );
        const statusData = await statusRes.json();
        if (statusRes.ok && statusData.last_checkin?.mood) {
            const health = document.getElementById("health-status");
            if (health) health.textContent = translateMood(statusData.last_checkin.mood);
        }
    } catch (error) {
        console.error("Check-in yüklenemedi:", error);
        list.innerHTML = '<p class="muted">Check-in kayıtları yüklenemedi.</p>';
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
    if (localStorage.getItem("family_sms_notify") === "1" && !prefs.sms) {
        prefs.sms = true;
        saveNotifyPrefs(prefs);
    }

    document.querySelectorAll("[data-pref]").forEach((input) => {
        const key = input.getAttribute("data-pref");
        if (key === "sms") input.checked = Boolean(prefs.sms);
        else input.checked = prefs[key] !== false;

        input.addEventListener("change", () => {
            const next = loadNotifyPrefs();
            next[key] = input.checked;
            saveNotifyPrefs(next);
            const status = document.getElementById("notifyPrefsStatus");
            if (status) status.textContent = "Bildirim tercihleri kaydedildi.";
            renderMedicationAlerts(cachedAlerts);
            renderAllAlerts(cachedAlerts);
            updateAlertCount(filterAlertsByPrefs(cachedAlerts).length);
        });
    });
}

async function fetchDashboardData() {
    const elderlyId = localStorage.getItem("elderly_id");
    const elderProfileId = await syncElderForFamily();

    try {
        const response = await fetch(`${API_BASE_URL}/family/dashboard-summary/${elderlyId}`);
        const data = await response.json();

        if (response.ok && data.success) {
            const health = document.getElementById("health-status");
            const activity = document.getElementById("activity-status");
            if (health && data.latest_mood) health.textContent = translateMood(data.latest_mood);
            if (activity) activity.textContent = data.activity_status || "—";

            if (data.medication_status) {
                const pill = document.getElementById("pill-status");
                if (pill) pill.textContent = data.medication_status;
            }

            if (data.medication_stats?.weekly_trend) {
                renderWeeklyTrend(data.medication_stats.weekly_trend);
            }

            if (data.recent_alerts) {
                cachedAlerts = data.recent_alerts;
                renderMedicationAlerts(cachedAlerts);
                renderAllAlerts(cachedAlerts);
                updateAlertCount(filterAlertsByPrefs(cachedAlerts).length);
            }
        }

        if (elderProfileId) {
            const statsRes = await fetch(`${API_BASE_URL}/medication/stats/${elderProfileId}`);
            const stats = await statsRes.json();
            if (statsRes.ok) {
                const rate = stats.adherence_rate ?? 0;
                const pill = document.getElementById("pill-status");
                if (pill) {
                    pill.textContent = stats.total_logs > 0 ? `%${rate} uyum` : "Henüz kayıt yok";
                }
                renderWeeklyTrend(stats.weekly_trend);

                const alertsRes = await fetch(`${API_BASE_URL}/medication/alerts/${elderProfileId}`);
                const alertsData = await alertsRes.json();
                if (alertsRes.ok) {
                    cachedAlerts = alertsData.alerts || [];
                    renderMedicationAlerts(cachedAlerts);
                    renderAllAlerts(cachedAlerts);
                    updateAlertCount(filterAlertsByPrefs(cachedAlerts).length);
                }
            }

            await loadEventHistory(elderProfileId);
        }

        const aiBox = document.getElementById("ai-summary");
        if (aiBox) aiBox.textContent = "Yapay zeka konuşmaları analiz ediyor…";

        const aiResponse = await fetch(`${API_BASE_URL}/family/generate-ai-summary`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ conversation_id: elderlyId }),
        });

        const aiData = await aiResponse.json();
        if (aiBox) {
            if (aiResponse.ok && aiData.success) {
                aiBox.textContent = aiData.summary;
            } else {
                aiBox.textContent = "Bugünkü sohbet analizi yüklenirken bir sorun oluştu.";
            }
        }
    } catch (error) {
        console.error("Dashboard verisi veya AI özeti çekilirken hata:", error);
    }
}

function translateMood(mood) {
    const moods = {
        good: "Harika",
        bad: "Biraz halsiz",
        normal: "Normal",
        tired: "Yorgun",
        "Harika!": "Harika",
        "Biraz halsizim": "Biraz halsiz",
    };
    return moods[mood] || mood || "—";
}

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
            return `
                <div class="chat-bubble ${isUser ? "is-user" : "is-assistant"}">
                    <span class="chat-role">${label}</span>
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
    }
}
window.switchDashboardTab = switchDashboardTab;

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
