let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let stream = null;

// Basit ve güvenli bir UUID üreteci fonksiyon
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Uygulama ilk açıldığında taze ve benzersiz bir konuşma ID'si tanımlıyoruz
let activeChatId = generateUUID();

// Check-in takibi (kalıcı) için sohbetten BAĞIMSIZ bir kimlik lazım.
// activeChatId her yenilemede değiştiği için "bugün check-in yapıldı mı" kontrolü onunla yapılamaz.
// Bunun için login.html'de giriş yapan kullanıcının GERÇEK user_id'sini kullanıyoruz,
// böylece farklı hesaplarla girişte check-in durumu birbirine karışmaz.
// Giriş yapan kullanıcının gerçek adı (login.html'de kaydedilir).
// Login akışı hiç kullanılmadan test amaçlı doğrudan app.html açıldıysa varsayılan bir isim gösterilir.
let userDisplayName = localStorage.getItem('user_name') || 'Ahmet Amca';

let elderProfileId = localStorage.getItem('user_id');
if (!elderProfileId) {
    // Login akışı hiç kullanılmadan (test amaçlı) doğrudan app.html açıldıysa
    // yine de check-in özelliği çalışsın diye geçici bir kimlik üretip saklıyoruz.
    elderProfileId = localStorage.getItem('elder_profile_id_fallback');
    if (!elderProfileId) {
        elderProfileId = generateUUID();
        localStorage.setItem('elder_profile_id_fallback', elderProfileId);
    }
}

// Sohbet mesajlarını 'users' tablosuna bağlamak için SADECE gerçek login'den gelen kimlik kullanılır.
// (elderProfileId bazen rastgele bir "yedek" kimlik olabilir; onu messages.user_id olarak göndermek
// veritabanında foreign key hatasına yol açar çünkü users tablosunda öyle bir kayıt yoktur.)
const realUserId = localStorage.getItem('user_id') || null;

const voiceBtn = document.getElementById('voiceBtn');
const btnText = document.getElementById('btnText');
const chatBox = document.getElementById('chatBox');
const chatScroll = document.getElementById('chatScroll');
const userInput = document.getElementById('userInput');
const historySidebar = document.getElementById('historySidebar');
const historyTodayList = document.getElementById('history-today');
const historyReopenBtn = document.getElementById('historyReopenBtn');

function getOwnerElderId() {
    return localStorage.getItem('elder_id') || null;
}

function getOwnerUserId() {
    return localStorage.getItem('user_id') || localStorage.getItem('elder_profile_id_fallback') || null;
}

async function ensureElderIdForOwner() {
    const userId = getOwnerUserId();
    const storedElderId = localStorage.getItem('elder_id');
    const boundUserId = localStorage.getItem('elder_bound_user_id');

    if (storedElderId && userId && boundUserId === userId) {
        return storedElderId;
    }

    if (!userId) return null;

    // Stale elder_id temizle
    localStorage.removeItem('elder_id');

    try {
        const response = await fetch(`${API_BASE_URL}/medications/sync-elder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: userId,
                user_name: userDisplayName,
            }),
        });
        const data = await response.json();
        if (response.ok && data.elder && data.elder.id) {
            localStorage.setItem('elder_id', data.elder.id);
            localStorage.setItem('elder_bound_user_id', userId);
            return data.elder.id;
        }
    } catch (error) {
        console.warn('elder_id çözülemedi:', error);
    }
    return null;
}

function isHistorySidebarOpen() {
    return historySidebar && !historySidebar.classList.contains('is-collapsed');
}

function syncHistoryReopenBtn() {
    if (!historyReopenBtn) return;
    const onChat = document.getElementById('page-sohbet')?.classList.contains('active');
    const show = onChat && historySidebar && historySidebar.classList.contains('is-collapsed');
    historyReopenBtn.classList.toggle('is-visible', Boolean(show));
    historyReopenBtn.classList.toggle('is-hidden', !show);
}

function openHistorySidebar() {
    if (!historySidebar) return;
    historySidebar.classList.remove('is-collapsed');
    historySidebar.style.display = 'flex';
    syncHistoryReopenBtn();
}

function closeHistorySidebar() {
    if (!historySidebar) return;
    historySidebar.classList.add('is-collapsed');
    syncHistoryReopenBtn();
}

function toggleHistorySidebar() {
    if (!historySidebar) return;
    if (isHistorySidebarOpen()) closeHistorySidebar();
    else openHistorySidebar();
}

function startNewChat() {
    try {
        switchPage("sohbet");
    } catch (_) { /* ignore */ }

    activeChatId = generateUUID();
    const box = document.getElementById("chatBox");
    if (box) {
        box.innerHTML = `
            <div class="chat-msg msg-ai">
                Merhaba ${userDisplayName}! Yeni bir sohbete başladık. Bugün nasılsın?
            </div>
        `;
    }
    document.querySelectorAll(".history-item").forEach((el) => el.classList.remove("active-chat"));
    openHistorySidebar();
    if (window.matchMedia("(max-width: 900px)").matches) {
        // mobilde listeyi açık tut, sonra isteğe göre kapatılabilir
    }
}

window.toggleHistorySidebar = toggleHistorySidebar;
window.closeHistorySidebar = closeHistorySidebar;
window.openHistorySidebar = openHistorySidebar;
window.startNewChat = startNewChat;

const API_BASE_URL = (window.CONFIG && CONFIG.API_BASE_URL) || "http://127.0.0.1:8000/api";

async function initKioskDemoMode() {
    const params = new URLSearchParams(window.location.search);
    const forceDemo = params.get('demo') === '1';
    const hasLogin = Boolean(localStorage.getItem('user_id'));

    if (hasLogin && !forceDemo) {
        return false;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/medications/demo/kiosk`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || 'Demo mod başlatılamadı');
        }

        localStorage.setItem('elder_id', data.elder.id);
        localStorage.setItem('elder_bound_user_id', data.demo_user_id);
        localStorage.setItem('kiosk_demo_mode', '1');
        localStorage.setItem('user_name', 'Ahmet Amca');
        localStorage.setItem('elder_profile_id_fallback', data.demo_user_id);

        userDisplayName = 'Ahmet Amca';
        elderProfileId = data.demo_user_id;

        console.log('[DEMO] Kiosk demo hazır:', data);
        return data;
    } catch (error) {
        console.error('Demo mod hatası:', error);
        return false;
    }
}

// Sayfa ilk yüklendiğinde Supabase'deki geçmiş sohbetleri getirir

window.addEventListener('DOMContentLoaded', async () => {
    await initKioskDemoMode();
    await ensureElderIdForOwner();

    // Küçük ekranda geçmiş kapalı başlasın; masaüstünde açık
    if (window.matchMedia('(max-width: 900px)').matches) {
        closeHistorySidebar();
    } else {
        openHistorySidebar();
    }
    syncHistoryReopenBtn();

    // 1. Sol menüdeki geçmiş başlıklarını çek ve oluştur
    await loadConversationsFromSupabase();
    
    // 2. Otomatik tıklama mantığını kaldırıyoruz! 
    // Sayfa her açıldığında ekran dünkü sohbetle dolmayacak, bugünün temiz oturumuyla başlayacak.
    chatBox.innerHTML = `
        <div class="chat-msg msg-ai">
            Merhaba ${userDisplayName}! Ben Yanımda Al. Bugün nasılsın?
            Yazabilir veya aşağıdaki butonla konuşabilirsin.
        </div>
    `;
    
    // Sol menüdeki "active-chat" (seçili) görsel vurgusunu temizle
    document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active-chat'));

    // "Durumum" sekmesindeki karşılama metnini gerçek kullanıcı adıyla doldur
    const checkinGreetingEl = document.getElementById('checkinGreeting');
    if (checkinGreetingEl) {
        checkinGreetingEl.textContent = `${userDisplayName}, bugün kendini nasıl hissediyorsun?`;
    }

    // İlaç listesini API'den yükle
    if (typeof MedicationDefinitions !== 'undefined') {
        await MedicationDefinitions.init({
            mode: 'kiosk',
            apiBaseUrl: API_BASE_URL,
            todayOnly: true,
            userId: localStorage.getItem('user_id') || localStorage.getItem('elder_profile_id_fallback'),
            userName: userDisplayName,
            elderId: localStorage.getItem('elder_id'),
        });
    }

    // elder_id eşleştikten sonra WebSocket bağlantısını kur
    initWebSocket();

    // Demo modda check-in pop-up'ını gösterme
    if (!localStorage.getItem('kiosk_demo_mode')) {
        checkAndShowCheckinReminder();
    }

    const newChatBtn = document.getElementById('historyNewChatBtn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', (event) => {
            event.preventDefault();
            startNewChat();
        });
    }
});

// Sayfa açılışında bugün check-in yapılıp yapılmadığını kontrol edip gerekirse pop-up gösterir.
// Pop-up, check-in yapılmadığı sürece günde en fazla 3 kez gösterilir, sonrasında sessiz kalır.
const MAX_DAILY_REMINDERS = 3;

async function checkAndShowCheckinReminder() {
    try {
        const response = await fetch(`${API_BASE_URL}/checkin/status?conversation_id=${elderProfileId}`);
        const data = await response.json();

        if (data.checked_in_today) {
            return; // Check-in zaten yapılmış, hiç gösterme
        }

        const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const dateKey = `checkin_reminder_date_${elderProfileId}`;
        const countKey = `checkin_reminder_count_${elderProfileId}`;
        const storedDate = localStorage.getItem(dateKey);
        let shownCount = parseInt(localStorage.getItem(countKey) || '0', 10);

        // Gün değiştiyse sayaç sıfırlanır
        if (storedDate !== todayStr) {
            shownCount = 0;
            localStorage.setItem(dateKey, todayStr);
        }

        if (shownCount >= MAX_DAILY_REMINDERS) {
            return; // Bugün için gösterim hakkı bitti, artık rahatsız etme
        }

        const modal = document.getElementById('checkinReminderModal');
        if (modal) modal.style.display = 'flex';

        localStorage.setItem(countKey, String(shownCount + 1));
    } catch (error) {
        console.error("Check-in hatırlatma kontrolü başarısız:", error);
    }
}

// "Şimdi Bildir" butonu: pop-up'ı kapatıp doğrudan Durumum sekmesine götürür
function goToCheckinFromReminder() {
    document.getElementById('checkinReminderModal').style.display = 'none';
    switchPage('durum');
}

// "Daha Sonra" butonu: pop-up'ı sadece kapatır, kullanıcı istediği zaman Durumum sekmesinden bildirebilir
function dismissCheckinReminder() {
    document.getElementById('checkinReminderModal').style.display = 'none';
}

function switchPage(pageId) {
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    document.querySelectorAll('.nav-btn, .app-tab').forEach(btn => btn.classList.remove('active'));
    const pageEl = document.getElementById(`page-${pageId}`);
    if (pageEl) pageEl.classList.add('active');
    const navEl = document.getElementById(`nav-${pageId}`);
    if (navEl) navEl.classList.add('active');
    
    if (pageId === 'sohbet') {
        if (historySidebar) {
            if (!historySidebar.classList.contains('is-collapsed')) {
                historySidebar.style.display = 'flex';
            }
        }
        syncHistoryReopenBtn();
    } else {
        if (historySidebar) historySidebar.style.display = 'none';
        if (historyReopenBtn) {
            historyReopenBtn.classList.remove('is-visible');
            historyReopenBtn.classList.add('is-hidden');
        }
    }

    if (pageId === 'durum') {
        loadCheckinHistory();
        loadCheckinStatus();
    }

    if (pageId === 'ilaclar' && typeof MedicationDefinitions !== 'undefined') {
        MedicationDefinitions.refresh();
    }
}

window.switchPage = switchPage;
window.appendMessageToUI = appendMessageToUI;
window.toggleVoice = toggleVoice;
window.completeCheckin = completeCheckin;
window.checkinFollowUpMessage = checkinFollowUpMessage;
window.showMedicationAlert = showMedicationAlert;
window.logMedication = logMedication;
window.dismissMedicationAlert = dismissMedicationAlert;
window.getOwnerElderId = getOwnerElderId;
window.loadConversationsFromSupabase = loadConversationsFromSupabase;
window.loadCheckinHistory = loadCheckinHistory;
window.loadCheckinStatus = loadCheckinStatus;
window.goToCheckinFromReminder = typeof goToCheckinFromReminder === 'function' ? goToCheckinFromReminder : undefined;
window.dismissCheckinReminder = dismissCheckinReminder;
window.openMedicationCamera = openMedicationCamera;

// enhance.js için canlı state
Object.defineProperty(window, 'activeChatId', { get: () => activeChatId, set: (v) => { activeChatId = v; } });
Object.defineProperty(window, 'userDisplayName', { get: () => userDisplayName, set: (v) => { userDisplayName = v; } });
Object.defineProperty(window, 'elderProfileId', { get: () => elderProfileId, set: (v) => { elderProfileId = v; } });
Object.defineProperty(window, 'realUserId', { get: () => realUserId });
Object.defineProperty(window, 'isRecording', { get: () => isRecording, set: (v) => { isRecording = v; } });
Object.defineProperty(window, 'mediaRecorder', { get: () => mediaRecorder, set: (v) => { mediaRecorder = v; } });
Object.defineProperty(window, 'audioChunks', { get: () => audioChunks, set: (v) => { audioChunks = v; } });
Object.defineProperty(window, 'stream', { get: () => stream, set: (v) => { stream = v; } });
Object.defineProperty(window, 'currentMedAlert', { get: () => currentMedAlert, set: (v) => { currentMedAlert = v; } });
Object.defineProperty(window, 'snoozeTimer', { get: () => snoozeTimer, set: (v) => { snoozeTimer = v; } });
window.API_BASE_URL = API_BASE_URL;

// Check-in eksikliği tespiti: bugün check-in yapılmış mı, banner ile göster
async function loadCheckinStatus() {
    const banner = document.getElementById('checkinStatusBanner');
    if (!banner) return;
    try {
        const response = await fetch(`${API_BASE_URL}/checkin/status?conversation_id=${elderProfileId}`);
        const data = await response.json();

        if (data.checked_in_today) {
            const time = new Date(data.last_checkin.created_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
            banner.innerHTML = `
                <div style="background:#ECFDF5; border:1px solid #A7F3D0; color:#065F46; border-radius:10px; padding:12px 16px; font-weight:600; text-align:center;">
                    ✅ Bugün check-in yapıldı (saat ${time}, durum: ${data.last_checkin.mood})
                </div>
            `;
        } else {
            banner.innerHTML = `
                <div style="background:#FFFBEB; border:1px solid #FDE68A; color:#92400E; border-radius:10px; padding:12px 16px; font-weight:600; text-align:center;">
                    ⚠️ Bugün henüz check-in yapılmadı. Lütfen durumunu bildir.
                </div>
            `;
        }
    } catch (error) {
        console.error(error);
        banner.innerHTML = "";
    }
}

// Günlük check-in geçmişini çekme
let checkinHistoryCache = [];
let checkinChartRange = "week";

function moodScore(mood) {
    const value = String(mood || "").toLocaleLowerCase("tr-TR");
    if (value.includes("harika") || value.includes("çok iyi") || value.includes("iyi")) return 3;
    if (value.includes("halsiz") || value.includes("yorgun") || value.includes("kötü")) return 1;
    return 2;
}

function setCheckinChartRange(range) {
    checkinChartRange = range;
    document.querySelectorAll(".checkin-chart-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.range === range);
    });
    renderCheckinChart(checkinHistoryCache, range);
}
window.setCheckinChartRange = setCheckinChartRange;

function renderCheckinChart(history, range) {
    const chart = document.getElementById("checkinChart");
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
                    return d.toDateString() === now.toDateString() && d.getHours() >= start && d.getHours() < start + 4;
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
                items: history.filter((item) => new Date(item.created_at).toDateString() === day.toDateString()),
            };
        });
    }

    chart.innerHTML = buckets
        .map((bucket) => {
            const scores = bucket.items.map((item) => moodScore(item.mood));
            const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
            const height = scores.length ? Math.max(12, Math.round((avg / 3) * 140)) : 8;
            const cls = !scores.length ? "is-empty" : avg >= 2.5 ? "" : avg >= 1.5 ? "is-low" : "is-bad";
            return `
                <div class="checkin-bar" title="${bucket.items.length} kayıt">
                    <div class="checkin-bar-fill ${cls}" style="height:${height}px"></div>
                    <label>${bucket.label}</label>
                </div>`;
        })
        .join("");
}

async function loadCheckinHistory() {
    const historyBox = document.getElementById('checkinHistory');
    try {
        const response = await fetch(`${API_BASE_URL}/checkin/history?conversation_id=${elderProfileId}`);
        const data = await response.json();
        const history = data.history || [];
        checkinHistoryCache = history;

        if (history.length === 0) {
            historyBox.innerHTML = `<p class="muted">Henüz bu oturuma ait durum kaydı yok.</p>`;
            renderCheckinChart([], checkinChartRange);
            return;
        }

        historyBox.innerHTML = history.map(item => {
            const date = new Date(item.created_at);
            const dateStr = date.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const timeStr = date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
            return `
                <div class="checkin-history-item">
                    <strong>${item.mood}</strong>
                    <span>${dateStr} • ${timeStr}</span>
                </div>
            `;
        }).join('');
        renderCheckinChart(history, checkinChartRange);
    } catch (error) {
        console.error(error);
        historyBox.innerHTML = `<p style="color: var(--warning-color); font-size: 16px;">Kayıtlar yüklenemedi.</p>`;
    }
}

// Supabase'den kullanıcıya özel sohbet listesini çeker (içerik başlıklı)
async function loadConversationsFromSupabase() {
    if (!historyTodayList) return;
    historyTodayList.innerHTML = "";

    const emptyHint = document.getElementById('historyEmptyHint');
    const elderId = getOwnerElderId();
    const userId = getOwnerUserId();

    if (!elderId && !userId) {
        if (emptyHint) emptyHint.style.display = 'block';
        return;
    }

    try {
        const params = new URLSearchParams();
        if (elderId) params.set('elder_id', elderId);
        if (userId) params.set('user_id', userId);

        const response = await fetch(`${API_BASE_URL}/conversations?${params.toString()}`);
        const conversations = await response.json();

        if (!Array.isArray(conversations) || conversations.length === 0) {
            if (emptyHint) emptyHint.style.display = 'block';
            return;
        }

        if (emptyHint) emptyHint.style.display = 'none';

        conversations.forEach((conv) => {
            const item = document.createElement('div');
            item.className = `history-item ${conv.conversation_id === activeChatId ? 'active-chat' : ''}`;
            item.innerText = conv.title || 'Sohbet';
            item.title = conv.title || '';
            item.setAttribute('data-id', conv.conversation_id);
            item.onclick = () => {
                loadSpecificChatFromServer(conv.conversation_id);
                if (window.matchMedia('(max-width: 900px)').matches) {
                    closeHistorySidebar();
                }
            };
            historyTodayList.appendChild(item);
        });
    } catch (error) {
        console.error("Geçmiş yüklenirken hata:", error);
    }
}

// Geçmişteki bir sohbete tıklandığında mesajları getiren fonksiyon
async function loadSpecificChatFromServer(id) {
    activeChatId = id; 
    chatBox.innerHTML = ""; 
    
    try {
        const response = await fetch(`${API_BASE_URL}/conversations/${id}`);
        const messages = await response.json();

        if (!messages || messages.length === 0) {
            chatBox.innerHTML = `<div class="chat-msg msg-ai">Bu sohbet boş görünüyor ${userDisplayName}.</div>`;
            return;
        }

        messages.forEach(msg => {
            appendMessageToUI(msg.content, msg.role);
        });
        
        chatScroll.scrollTop = chatScroll.scrollHeight;
        
        document.querySelectorAll('.history-item').forEach(el => {
            if (el.getAttribute('data-id') === id) {
                el.classList.add('active-chat');
            } else {
                el.classList.remove('active-chat');
            }
        });
    } catch (error) {
        console.error("Mesaj geçmişi getirilemedi:", error);
    }
}

// Yazılı Mesaj Gönderme (Eşitlenmiş Model)
async function sendTextMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    appendMessageToUI(text, "user");
    userInput.value = "";

    try {
        const response = await fetch(`${API_BASE_URL}/text-chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                conversation_id: activeChatId, // Backend'in beklediği dinamik ID gidiyor
                message: text,
                user_id: realUserId,           // Mesajı gerçek kayıtlı kullanıcıya bağlar (giriş yoksa null)
                user_name: userDisplayName,    // AI'ın doğru isimle hitap edebilmesi için
                elder_id: getOwnerElderId(),
            })
        });
        const data = await response.json();
        appendMessageToUI(data.ai_response, "ai");
        
        // Sol menüyü yenile ki yeni bir gün/oturumsa hemen listeye düşsün
        await loadConversationsFromSupabase();
    } catch (error) {
        console.error(error);
        appendMessageToUI(`Bağlantı hatası oluştu ${userDisplayName}.`, "ai");
    }
}

function handleKeyPress(event) {
    if (event.key === "Enter") {
        sendTextMessage();
    }
}

function appendMessageToUI(text, sender) {
    const msgDiv = document.createElement('div');
    let styleClass = 'user';
    if (sender === 'assistant' || sender === 'ai' || sender === 'system') {
        styleClass = 'ai';
    }
    msgDiv.className = `chat-msg msg-${styleClass}`;
    msgDiv.innerText = text;
    chatBox.appendChild(msgDiv);
    chatScroll.scrollTop = chatScroll.scrollHeight;
}

// Ses Kayıt ve Gönderme Mantığı
async function toggleVoice() {
    if (!isRecording) {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            mediaRecorder = new MediaRecorder(stream);

            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) audioChunks.push(event.data);
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
                if (audioBlob.size < 1000) {
                    appendMessageToUI("Ses kaydedilemedi.", "ai");
                    return;
                }

                const formData = new FormData();
                formData.append("file", audioBlob, "audio.webm");
                formData.append("conversation_id", activeChatId); // Sesi de aktif sohbete bağlıyoruz
                if (realUserId) formData.append("user_id", realUserId); // Mesajı gerçek kayıtlı kullanıcıya bağlar
                formData.append("user_name", userDisplayName);    // AI'ın doğru isimle hitap edebilmesi için
                const ownerElderId = getOwnerElderId();
                if (ownerElderId) formData.append("elder_id", ownerElderId);
                try {
                    const response = await fetch(`${API_BASE_URL}/voice-chat`, { method: "POST", body: formData });
                    const data = await response.json();
                    appendMessageToUI(data.user_transcription, "user");
                    appendMessageToUI(data.ai_response, "ai");
                    await loadConversationsFromSupabase();
                } catch (err) {
                    console.error(err);
                    appendMessageToUI("Sunucuya bağlanılamadı.", "ai");
                }
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            isRecording = true;
            voiceBtn.classList.add("recording");
            btnText.innerText = "Dinliyorum...";
        } catch (err) {
            console.error(err);
            alert("Mikrofona erişim izni verilmedi.");
        }
    } else {
        isRecording = false;
        voiceBtn.classList.remove("recording");
        btnText.innerText = "Konuşmak İçin Basın";
        mediaRecorder.stop();
    }
}

function checkinFollowUpMessage(mood) {
    const value = String(mood || "")
        .toLocaleLowerCase("tr-TR")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    if (value.includes("halsiz") || value.includes("kotu") || value.includes("yorgun") || value.includes("kötü")) {
        return pick([
            "Durumunu ailenle paylaştık. Kendine iyi bak; istersen biraz sohbet edelim.",
            "Teşekkürler, haber verdin. Biraz dinlenmek iyi gelebilir. İstersen yanındayım.",
            "Not aldık ve ailen bilgilendirildi. Su içmeyi ve hafif bir mola vermeyi unutma.",
            "Anladım, bugün biraz yorgun hissediyorsun. İstersen birlikte konuşarak rahatlarız.",
            "Kaydettim. Ailen de haberiniz olsun diye bilgilendirildi. Kendine nazik davran.",
        ]);
    }
    if (value.includes("harika") || value === "iyi" || value.includes("cok iyi") || value.includes("çok iyi")) {
        return pick([
            "Ne güzel! Ailen de iyi olduğunu bilmekten mutlu olacak.",
            "Harika haber. Keyfin yerindeyse günün daha da güzel geçer.",
            "Sevindim! Keyfin yerinde olması güzel haber. Ailene de ilettik.",
            "Süper. Enerjin yerinde görünüyor; böyle devam.",
            "Güzel! Bugün iyi olman herkese moral olur. Ailen de bilgilendirildi.",
        ]);
    }
    return pick([
        "Durumun kaydedildi. Ailen bilgilendirildi.",
        "Teşekkürler, kaydınız alındı.",
        "Bildiriminiz kaydedildi. İyi günler.",
    ]);
}

// Sağlık kontrolü durum bildirimi (Dinamik Oturum Bağlantılı)
async function completeCheckin(mood) {
    try {
        const response = await fetch(`${API_BASE_URL}/checkin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                conversation_id: elderProfileId,
                mood: mood,
                elder_id: localStorage.getItem("elder_id") || null,
                user_id: realUserId || elderProfileId,
            }),
        });

        let data = {};
        try {
            data = await response.json();
        } catch (_) {
            data = {};
        }

        if (!response.ok) {
            const detail = data.detail || "Check-in kaydedilemedi.";
            alert(typeof detail === "string" ? detail : "Check-in kaydedilemedi.");
            return;
        }

        const followUp = checkinFollowUpMessage(mood);
        document.getElementById("checkinCard").innerHTML = `
            <span style="font-size: 64px;">✔️</span>
            <h2 style="color: var(--success-color); font-size: 30px; font-weight: 800;">Durumunuz Bildirildi</h2>
            <p style="font-size: 20px; color: var(--text-muted); margin-top: 8px;">${followUp}</p>
            <p style="font-size: 18px; color: var(--text-main); margin-top: 12px; font-weight: 600;">Kaydedilen durum: ${mood}</p>
        `;

        const banner = document.getElementById("checkinStatusBanner");
        if (banner) {
            const time = new Date().toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
            banner.innerHTML = `
                <div style="background:#ECFDF5; border:1px solid #A7F3D0; color:#065F46; border-radius:10px; padding:12px 16px; font-weight:600; text-align:center;">
                    ✅ Bugün check-in yapıldı (saat ${time}, durum: ${mood})
                </div>
            `;
        }

        appendMessageToUI(`Günlük sağlık kontrolü yapıldı: ${mood}`, "user");
        loadCheckinHistory();
        loadCheckinStatus();
    } catch (error) {
        console.error(error);
        alert("Bağlantı hatası.");
    }
}

// İlaç onay mekanizması (eski stub — MedicationDefinitions'a yönlendirir)
async function takeMed(medicationId) {
    if (typeof MedicationDefinitions !== 'undefined') {
        const card = document.getElementById(`med-card-${medicationId}`);
        const medName = card?.dataset?.medName || 'İlaç';
        await MedicationDefinitions.markTaken(medicationId, null, medName);
    }
}

// WEBSOCKET: İlaç Hatırlatma Sistemi
let medicationSocket = null;
let currentMedAlert = null;
let snoozeTimer = null;
const SNOOZE_MINUTES = 10;

function getElderIdForWs() {
    return (
        (typeof MedicationDefinitions !== 'undefined' && MedicationDefinitions.getElderId()) ||
        localStorage.getItem('elder_id') ||
        elderProfileId
    );
}

function initWebSocket() {
    const elderId = getElderIdForWs();
    if (!elderId) return;

    if (medicationSocket) {
        medicationSocket.onclose = null;
        medicationSocket.close();
    }

    const wsBase = (window.CONFIG && CONFIG.WS_BASE_URL) || "ws://127.0.0.1:8000";
    const wsUrl = `${wsBase}/ws/medication/${elderId}`;
    medicationSocket = new WebSocket(wsUrl);

    medicationSocket.onopen = () => console.log(`WebSocket bağlandı (elder: ${elderId})`);
    medicationSocket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.aksiyon === 'ILAC_HATIRLATMA') {
                showMedicationAlert(data);
            }
        } catch (e) {
            console.error('WS mesaj hatası', e);
        }
    };
    medicationSocket.onclose = () => {
        console.log('WebSocket koptu. Tekrar deneniyor...');
        setTimeout(initWebSocket, 5000);
    };
}

function speakTurkish(text) {
    if ('speechSynthesis' in window) {
        const msg = new SpeechSynthesisUtterance(text);
        msg.lang = 'tr-TR';
        window.speechSynthesis.speak(msg);
    }
}

function showMedicationAlert(data) {
    currentMedAlert = data;

    switchPage('ilaclar');

    document.getElementById('medAlertTitle').innerText = `${data.ilac_adi} Saati!`;
    document.getElementById('medAlertDesc').innerText = `Lütfen doz: ${data.dozaj || 'Belirtilmemiş'} ilacınızı alın.`;
    document.getElementById('medicationAlertModal').style.display = 'flex';

    speakTurkish(`İlaç saatiniz geldi. Lütfen ${data.ilac_adi} ilacınızı alın.`);
}

async function logMedication(status, method) {
    if (!currentMedAlert) return;

    try {
        const formData = new FormData();
        formData.append('medication_id', currentMedAlert.medication_id);
        formData.append('status', status);
        formData.append('confirmed_method', method);
        if (currentMedAlert.schedule_id) {
            formData.append('schedule_id', currentMedAlert.schedule_id);
        }

        await fetch(`${API_BASE_URL}/medication/log`, {
            method: 'POST',
            body: formData,
        });

        document.getElementById('medicationAlertModal').style.display = 'none';

        if (status === 'taken') {
            speakTurkish('Teşekkürler, ilacınızı içtiğiniz kaydedildi.');
            appendMessageToUI(`${currentMedAlert.ilac_adi} ilacı başarıyla alındı.`, 'system');
            if (typeof MedicationDefinitions !== 'undefined') {
                MedicationDefinitions.refresh();
            }
        } else if (status === 'snoozed') {
            speakTurkish('Tamam, biraz sonra tekrar hatırlatacağım.');
            scheduleSnoozeReminder();
        }

        if (status !== 'snoozed') {
            currentMedAlert = null;
        }
    } catch (e) {
        console.error('Log hatası:', e);
    }
}

function scheduleSnoozeReminder() {
    if (snoozeTimer) clearTimeout(snoozeTimer);
    snoozeTimer = setTimeout(() => {
        if (currentMedAlert) {
            showMedicationAlert(currentMedAlert);
        }
    }, SNOOZE_MINUTES * 60 * 1000);
}

function openMedicationCamera() {
    document.getElementById('medicationAlertModal').style.display = 'none';
    if (typeof MedicationRecognition !== 'undefined' && currentMedAlert) {
        MedicationRecognition.open(
            currentMedAlert.medication_id,
            currentMedAlert.ilac_adi,
            currentMedAlert.schedule_id
        );
    }
}

function dismissMedicationAlert() {
    logMedication('snoozed', 'snooze');
}
