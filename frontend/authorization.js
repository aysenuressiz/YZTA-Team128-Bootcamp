const API_BASE_URL = (window.CONFIG && CONFIG.API_BASE_URL) || "http://127.0.0.1:8000/api";
const FACE_ANALYSIS_TIMEOUT_MS = 100000;
const REGISTER_TIMEOUT_MS = 30000;

let localStream = null;
let registerStream = null;
let registeredBase64Image = null; // Geriye uyumluluk: son çekilen kare

const FACE_CAPTURE_STEPS = [
    { key: "front", label: "Ön", hint: "Kameraya düz bakın" },
    { key: "left", label: "Sol", hint: "Hafif sola dönün (yüzünüzün sol yanını gösterin)" },
    { key: "right", label: "Sağ", hint: "Hafif sağa dönün (yüzünüzün sağ yanını gösterin)" },
];
let faceCaptureIndex = 0;
let registeredFaceImages = []; // [{ key, label, dataUrl }]

/** Giriş/kayıt sonrası oturum — eski elder_id ile ilaç karışmasını önler */
function clearStaleSessionKeys() {
    localStorage.removeItem("elder_id");
    localStorage.removeItem("elder_bound_user_id");
    localStorage.removeItem("kiosk_demo_mode");
    localStorage.removeItem("elder_profile_id_fallback");
}

function persistAuthSession({ userId, userName, elderId = null, role = "elderly" }) {
    const needsSetup = localStorage.getItem("needs_profile_setup") === "1";
    clearStaleSessionKeys();
    localStorage.removeItem("kiosk_demo_mode");
    if (needsSetup) localStorage.setItem("needs_profile_setup", "1");
    if (userId) localStorage.setItem("user_id", userId);
    if (userName) localStorage.setItem("user_name", userName);
    localStorage.setItem("user_role", role);
    if (elderId) {
        localStorage.setItem("elder_id", elderId);
        if (userId) localStorage.setItem("elder_bound_user_id", userId);
    }
}

// Sayfa yüklendiğinde kamerayı otomatik açma — kullanıcı isterse açar
window.addEventListener("DOMContentLoaded", () => {
    /* login: kamera isteğe bağlı panelde */
});

// Giriş ekranında sekmeler arası geçiş (Yaşlı vs Refakatçi)
function switchAuthTab(tabName) {
    const elderlyBtn = document.getElementById("tab-btn-elderly");
    const familyBtn = document.getElementById("tab-btn-family");
    const elderlyPanel = document.getElementById("tab-elderly");
    const familyPanel = document.getElementById("tab-family");

    document.querySelectorAll(".login-tab").forEach((btn) => {
        btn.classList.remove("active");
        btn.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".login-panel").forEach((panel) => {
        panel.classList.remove("active");
        panel.hidden = true;
    });

    // Eski sheet.css sekmeleri (varsa)
    document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((content) => content.classList.remove("active"));

    if (tabName === "elderly") {
        elderlyBtn?.classList.add("active");
        elderlyBtn?.setAttribute("aria-selected", "true");
        if (elderlyPanel) {
            elderlyPanel.classList.add("active");
            elderlyPanel.hidden = false;
        }
        document.querySelector("[onclick=\"switchAuthTab('elderly')\"]")?.classList.add("active");
        document.getElementById("tab-elderly")?.classList.add("active");
    } else {
        familyBtn?.classList.add("active");
        familyBtn?.setAttribute("aria-selected", "true");
        if (familyPanel) {
            familyPanel.classList.add("active");
            familyPanel.hidden = false;
        }
        document.querySelector("[onclick=\"switchAuthTab('family')\"]")?.classList.add("active");
        document.getElementById("tab-family")?.classList.add("active");
        if (typeof stopWebcam === "function") stopWebcam();
        if (typeof window.hideFaceScanProgress === "function") {
            window.hideFaceScanProgress();
        }
        const facePanel = document.getElementById("face-login-panel");
        if (facePanel) facePanel.hidden = true;
        const video = document.getElementById("webcam");
        if (video) video.classList.remove("is-on");
    }
}

window.switchAuthTab = switchAuthTab;

// =====================================================================
// 1. YAŞLI YÜZ TANIMA GİRİŞ FONKSİYONLARI
// =====================================================================

async function initWebcam() {
    const video = document.getElementById("webcam");
    const statusText = document.getElementById("face-status");
    if (!video) return;

    try {
        if (localStream) {
            localStream.getTracks().forEach((t) => t.stop());
        }
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
            audio: false,
        });
        video.srcObject = localStream;
        await video.play();
        video.classList.add("is-on");
        if (statusText) {
            statusText.classList.remove("is-error", "is-ok", "is-wait");
            statusText.classList.add("is-wait");
            statusText.innerText = "Kamera hazır. Yüzü tara butonuna basın.";
        }
    } catch (err) {
        console.error("Kameraya erişilemedi:", err);
        if (statusText) {
            statusText.classList.remove("is-error", "is-ok", "is-wait");
            statusText.classList.add("is-error");
            statusText.innerText = "Kamera izni verilmedi veya kamera bulunamadı.";
        }
    }
}

function stopWebcam() {
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }
    const video = document.getElementById("webcam");
    if (video) {
        video.srcObject = null;
        video.classList.remove("is-on");
    }
}

async function startFaceRecognition() {
    const video = document.getElementById("webcam");
    const statusText = document.getElementById("face-status");
    const scanBtn = document.getElementById("face-scan-btn");
    const showStatus = (msg, kind) => {
        if (typeof window.setLoginStatus === "function") {
            window.setLoginStatus(statusText, msg, kind);
        } else if (statusText) {
            statusText.innerText = msg;
        }
    };

    if (!video || !localStream) {
        showStatus("Önce kamerayı açın.", "error");
        return;
    }
    if (video.readyState < 2) {
        showStatus("Kamera henüz hazır değil, bir saniye bekleyin.", "wait");
        return;
    }

    if (scanBtn) scanBtn.disabled = true;
    if (typeof window.hideFaceScanProgress === "function") {
        window.hideFaceScanProgress();
    }
    if (typeof window.setFaceScanProgress === "function") {
        window.setFaceScanProgress(0, "Tarama başlıyor…", { force: true });
        window.setFaceScanProgress(8, "Kare alınıyor…");
    }
    showStatus("Yüzünüz taranıyor…", "wait");

    try {
        await new Promise((r) => setTimeout(r, 80));
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 400;
        canvas.height = video.videoHeight || 300;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        if (typeof window.setFaceScanProgress === "function") {
            window.setFaceScanProgress(22, "Görüntü hazırlanıyor…");
        }

        const base64Image = canvas.toDataURL("image/jpeg", 0.92);
        if (typeof window.setFaceScanProgress === "function") {
            window.setFaceScanProgress(35, "Sunucuya gönderiliyor…");
        }

        let result;
        if (typeof window.postFaceLoginWithProgress === "function") {
            result = await window.postFaceLoginWithProgress(base64Image);
        } else {
            const response = await fetch(`${API_BASE_URL}/auth/face-login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image_data: base64Image }),
            });
            const data = await response.json();
            result = { ok: response.ok, status: response.status, data };
        }

        const data = result.data || {};

        if (result.ok && data.success) {
            if (typeof window.setFaceScanProgress === "function") {
                window.setFaceScanProgress(100, "Tarama tamamlandı!", { done: true, force: true });
            }
            showStatus(`✔️ Giriş başarılı! Hoş geldiniz, ${data.name}`, "ok");
            if (typeof window.speakFaceLogin === "function") {
                window.speakFaceLogin(`Giriş başarılı. Hoş geldiniz ${data.name}.`);
            }
            stopWebcam();
            persistAuthSession({
                userId: data.user_id,
                userName: data.name,
                elderId: data.elder_id || null,
                role: "elderly",
            });
            setTimeout(() => {
                window.location.href = "app.html";
            }, 1100);
            return;
        }

        const detail = data.detail || "Yüz eşleşmedi. Lütfen tekrar deneyin.";
        if (typeof window.setFaceScanProgress === "function") {
            window.setFaceScanProgress(100, "Sonuç alındı", { fail: true, force: true });
        }
        showStatus(detail, "error");
        if (typeof window.speakFaceLogin === "function") {
            window.speakFaceLogin(detail);
        }
        setTimeout(() => {
            if (typeof window.hideFaceScanProgress === "function") {
                window.hideFaceScanProgress();
            }
        }, 1600);
    } catch (error) {
        console.error("Giriş hatası:", error);
        if (typeof window.stopFaceScanCreep === "function") {
            window.stopFaceScanCreep();
        }
        if (typeof window.setFaceScanProgress === "function") {
            window.setFaceScanProgress(100, "Bağlantı hatası", { fail: true, force: true });
        }
        const msg = error && error.message === "timeout"
            ? "Yüz analizi zaman aşımına uğradı. Şifre ile giriş deneyin veya tekrar deneyin."
            : "Sistem hatası. Sunucuya bağlanılamadı.";
        showStatus(msg, "error");
        if (typeof window.speakFaceLogin === "function") {
            window.speakFaceLogin(msg);
        }
        setTimeout(() => {
            if (typeof window.hideFaceScanProgress === "function") {
                window.hideFaceScanProgress();
            }
        }, 1600);
    } finally {
        if (scanBtn) scanBtn.disabled = false;
    }
}

// =====================================================================
// B PLANI: TELEFON VEYA E-POSTA + ŞİFRE İLE YAŞLI GİRİŞİ
// =====================================================================
function _loginDigits(value) {
    return String(value || "").replace(/\D+/g, "");
}

function _resolveContactFromForm(contactId, legacyPhoneId, legacyEmailId) {
    const contactEl = document.getElementById(contactId);
    if (contactEl && typeof window.parseLoginContact === "function") {
        return window.parseLoginContact(contactEl.value);
    }
    if (contactEl) {
        const raw = contactEl.value.trim();
        if (raw.includes("@")) return { phone: null, email: raw.toLowerCase() };
        return { phone: _loginDigits(raw) || null, email: null };
    }
    return {
        phone: _loginDigits(document.getElementById(legacyPhoneId)?.value || "") || null,
        email: (document.getElementById(legacyEmailId)?.value || "").trim().toLowerCase() || null,
    };
}

async function loginWithCredentials(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();

    const { phone, email } = _resolveContactFromForm(
        "elderly-login-contact",
        "elderly-login-phone",
        "elderly-login-email"
    );
    const password = document.getElementById("elderly-login-password")?.value || "";
    const statusText =
        document.getElementById("elderly-login-status") ||
        document.getElementById("face-status");

    const show = (msg, kind) => {
        if (typeof window.setLoginStatus === "function") {
            window.setLoginStatus(statusText, msg, kind);
        } else if (statusText) {
            statusText.innerText = msg;
        }
    };

    if ((!phone && !email) || !password) {
        show("Telefon veya e-posta ile birlikte şifrenizi girin.", "error");
        return;
    }
    if (phone && phone.length < 10) {
        show("Telefon numarası 10 haneli olmalıdır.", "error");
        return;
    }

    show("Bilgileriniz doğrulanıyor...", "wait");

    try {
        const response = await fetchWithTimeout(
            API_BASE_URL + "/auth/elderly-login",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    phone: phone || null,
                    email: email || null,
                    password: password,
                }),
            },
            15000
        );

        const data = await response.json();

        if (response.ok && data.success) {
            show("✔️ Giriş başarılı! Hoş geldiniz, " + data.name, "ok");
            stopWebcam();
            persistAuthSession({
                userId: data.user_id,
                userName: data.name,
                elderId: data.elder_id || null,
                role: "elderly",
            });
            window.location.href = "app.html";
        } else {
            show(data.detail || "Giriş başarısız. Bilgilerinizi kontrol edin.", "error");
        }
    } catch (error) {
        console.error("Yazılı giriş hatası:", error);
        if (error && error.name === "AbortError") {
            show(
                "Sunucu yanıt vermiyor (zaman aşımı). Backend'in 8000 portunda çalıştığından emin olun.",
                "error"
            );
        } else {
            show("Sunucu bağlantı hatası oluştu. Backend açık mı?", "error");
        }
    }
}

// =====================================================================
// 2. AİLE / REFAKATÇİ GİRİŞ FONKSİYONU (telefon veya e-posta + şifre)
// =====================================================================
async function handleFamilyLogin(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();

    const { phone, email } = _resolveContactFromForm(
        "family-login-contact",
        "login-phone",
        "login-email"
    );
    const password = document.getElementById("login-password")?.value || "";
    const statusText = document.getElementById("family-login-status");

    const show = (msg, kind) => {
        if (typeof window.setLoginStatus === "function") {
            window.setLoginStatus(statusText, msg, kind);
        } else if (statusText) {
            statusText.innerText = msg;
        }
    };

    if ((!phone && !email) || !password) {
        show("Telefon veya e-posta ile birlikte şifrenizi girin.", "error");
        return;
    }
    if (phone && phone.length < 10) {
        show("Telefon numarası 10 haneli olmalıdır.", "error");
        return;
    }

    show("Giriş yapılıyor...", "wait");

    try {
        const response = await fetchWithTimeout(
            API_BASE_URL + "/auth/family-login",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    phone: phone || null,
                    email: email || null,
                    password: password,
                }),
            },
            15000
        );

        const data = await response.json();

        if (response.ok && data.success) {
            show("✔️ Giriş başarılı!", "ok");
            clearStaleSessionKeys();
            localStorage.setItem("user_role", "family");
            localStorage.setItem("family_name", data.family_name);
            localStorage.setItem("elderly_id", data.elderly_id);
            localStorage.setItem("elderly_name", data.elderly_name);
            localStorage.setItem("user_id", data.user_id || data.elderly_id);
            if (data.elder_id) {
                localStorage.setItem("elder_id", data.elder_id);
                localStorage.setItem(
                    "elder_bound_user_id",
                    data.user_id || data.elderly_id || ""
                );
            }
            window.location.href = "family-dashboard.html";
        } else {
            show(data.detail || "Hatalı telefon / e-posta veya şifre!", "error");
        }
    } catch (error) {
        console.error(error);
        if (error && error.name === "AbortError") {
            show(
                "Sunucu yanıt vermiyor (zaman aşımı). Backend'in 8000 portunda çalıştığından emin olun.",
                "error"
            );
        } else {
            show("Bağlantı hatası! Backend açık mı?", "error");
        }
    }
}

window.loginWithCredentials = loginWithCredentials;
window.handleFamilyLogin = handleFamilyLogin;
window.initWebcam = initWebcam;
window.startFaceRecognition = startFaceRecognition;
window.stopWebcam = stopWebcam;

// =====================================================================
// 3. KAYIT OLMA (REGISTER) FONKSİYONLARI
// =====================================================================

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function updateAngleButtons() {
    FACE_CAPTURE_STEPS.forEach((step, index) => {
        const btn = document.getElementById(`angle-btn-${step.key}`);
        if (!btn) return;
        btn.classList.toggle("active", index === faceCaptureIndex);
        btn.classList.toggle(
            "done",
            registeredFaceImages.some((s) => s.key === step.key)
        );
    });
}

function selectFaceAngle(index) {
    if (index < 0 || index >= FACE_CAPTURE_STEPS.length) return;
    faceCaptureIndex = index;
    updateAngleButtons();
    const statusText = document.getElementById("reg-camera-status");
    if (statusText) {
        statusText.innerText = currentFaceStepHint();
        statusText.style.color = "var(--brand-color)";
    }
    if (registerStream) {
        setRegisterMediaMode("live");
    }
}

function skipFaceAndRegister() {
    registeredBase64Image = null;
    registeredFaceImages = [];
    faceCaptureIndex = 0;
    stopRegisterCamera();
    renderFaceThumbs();
    updateAngleButtons();
    const statusText = document.getElementById("reg-camera-status");
    if (statusText) {
        statusText.innerText = "Yüz atlandı — form bilgileriyle kayıt yapılacak.";
        statusText.style.color = "var(--text-muted)";
    }
    const form = document.getElementById("register-form");
    if (form) {
        handleRegister({ preventDefault: () => {}, target: form });
    }
}

function stopRegisterCamera() {
    if (registerStream) {
        registerStream.getTracks().forEach((track) => track.stop());
        registerStream = null;
    }
    const video = document.getElementById("reg-webcam");
    if (video) {
        video.srcObject = null;
    }
}

function setRegisterMediaMode(mode) {
    const video = document.getElementById("reg-webcam");
    const preview = document.getElementById("reg-preview");
    const openBtn = document.getElementById("reg-cam-open-btn");
    const captureBtn = document.getElementById("reg-cam-capture-btn");
    const nextBtn = document.getElementById("reg-cam-next-btn");

    if (video) video.style.display = mode === "live" ? "block" : "none";
    if (preview) preview.style.display = mode === "preview" ? "block" : "none";

    if (openBtn) openBtn.style.display = mode === "idle" ? "inline-block" : "none";
    if (captureBtn) captureBtn.style.display = mode === "live" ? "inline-block" : "none";
    if (nextBtn) nextBtn.style.display = mode === "preview" ? "inline-block" : "none";
}

function renderFaceThumbs() {
    const thumbs = document.getElementById("reg-thumbs");
    if (!thumbs) return;
    thumbs.innerHTML = "";
    FACE_CAPTURE_STEPS.forEach((step) => {
        const shot = registeredFaceImages.find((s) => s.key === step.key);
        if (!shot) return;
        const img = document.createElement("img");
        img.src = shot.dataUrl;
        img.alt = shot.label;
        img.title = shot.label;
        thumbs.appendChild(img);
    });
    updateAngleButtons();
}

function currentFaceStepHint() {
    const step = FACE_CAPTURE_STEPS[faceCaptureIndex];
    if (!step) return "Tüm açılar kaydedildi.";
    return `${faceCaptureIndex + 1}/${FACE_CAPTURE_STEPS.length} — ${step.hint}`;
}

async function tryExtractFaceVector(statusText) {
    const shots =
        registeredFaceImages.length > 0
            ? registeredFaceImages
            : registeredBase64Image
              ? [{ key: "front", label: "Ön", dataUrl: registeredBase64Image }]
              : [];

    if (!shots.length) {
        return null;
    }

    const angles = {};
    const vectors = [];

    for (let i = 0; i < shots.length; i += 1) {
        const shot = shots[i];
        if (statusText) {
            statusText.innerText = `Yüz analizi ${i + 1}/${shots.length} (${shot.label})...`;
            statusText.style.color = "orange";
        }

        try {
            const faceResponse = await fetchWithTimeout(
                `${API_BASE_URL}/auth/register-face`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ image_data: shot.dataUrl }),
                },
                FACE_ANALYSIS_TIMEOUT_MS
            );

            let faceData = {};
            try {
                faceData = await faceResponse.json();
            } catch (_) {
                faceData = {};
            }

            if (faceResponse.ok && faceData.success && faceData.face_vector) {
                angles[shot.key] = faceData.face_vector;
                vectors.push(faceData.face_vector);
                continue;
            }

            const detail = faceData.detail || "Yüz analizi başarısız.";
            console.warn(`${shot.label} açısı:`, detail);
            // Kaydı bloke etme — yüz olmadan devam
            continue;
        } catch (error) {
            console.warn(`${shot.label} yüz analizi hatası:`, error);
            continue;
        }
    }

    if (!vectors.length) {
        return null;
    }

    // Liste olarak sakla: girişte tüm açılarla karşılaştırılır
    return vectors.length === 1 ? vectors[0] : vectors;
}

async function openRegisterCamera() {
    const video = document.getElementById("reg-webcam");
    const preview = document.getElementById("reg-preview");
    const statusText = document.getElementById("reg-camera-status");
    if (!video) return;

    if (registeredFaceImages.length >= FACE_CAPTURE_STEPS.length) {
        registeredFaceImages = [];
        faceCaptureIndex = 0;
        renderFaceThumbs();
    }

    try {
        stopRegisterCamera();
        registerStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 400, height: 300, facingMode: "user" },
        });
        video.srcObject = registerStream;
        if (preview) preview.style.display = "none";
        setRegisterMediaMode("live");
        updateAngleButtons();
        if (statusText) {
            statusText.innerText = currentFaceStepHint();
            statusText.style.color = "var(--brand-color)";
        }
    } catch (err) {
        if (statusText) {
            statusText.innerText = "Kamera izni verilmedi veya kamera bulunamadı.";
            statusText.style.color = "red";
        }
        setRegisterMediaMode("idle");
    }
}

function captureRegisterFace() {
    const video = document.getElementById("reg-webcam");
    const preview = document.getElementById("reg-preview");
    const statusText = document.getElementById("reg-camera-status");
    if (!video || !registerStream) return;

    const step = FACE_CAPTURE_STEPS[faceCaptureIndex] || FACE_CAPTURE_STEPS[0];
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 400;
    canvas.height = video.videoHeight || 300;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    registeredBase64Image = dataUrl;
    registeredFaceImages = registeredFaceImages.filter((s) => s.key !== step.key);
    registeredFaceImages.push({ key: step.key, label: step.label, dataUrl });
    renderFaceThumbs();

    stopRegisterCamera();
    if (preview) {
        preview.src = dataUrl;
    }
    setRegisterMediaMode("preview");

    const done = registeredFaceImages.length >= FACE_CAPTURE_STEPS.length;
    if (statusText) {
        statusText.innerText = done
            ? "3 açı kaydedildi. Aşağıdaki küçük fotoğrafları kontrol edip kaydı tamamlayın."
            : `${step.label} kaydedildi. Üstteki oklarla sonraki açıyı seçin veya “Sonraki açı”ya basın.`;
        statusText.style.color = "green";
    }

    const nextBtn = document.getElementById("reg-cam-next-btn");
    if (nextBtn) {
        nextBtn.style.display = done ? "none" : "inline-block";
        nextBtn.innerText = "Sonraki açı ▶";
    }
    const openBtn = document.getElementById("reg-cam-open-btn");
    if (openBtn && done) {
        openBtn.style.display = "inline-block";
        openBtn.innerText = "Yeniden çek";
    }
}

async function continueNextFaceAngle() {
    if (registeredFaceImages.length >= FACE_CAPTURE_STEPS.length) {
        return;
    }
    // Sıradaki eksik açıyı seç
    const taken = new Set(registeredFaceImages.map((s) => s.key));
    const nextIndex = FACE_CAPTURE_STEPS.findIndex((s) => !taken.has(s.key));
    faceCaptureIndex = nextIndex >= 0 ? nextIndex : Math.min(
        registeredFaceImages.length,
        FACE_CAPTURE_STEPS.length - 1
    );
    updateAngleButtons();
    await openRegisterCamera();
}

async function handleRegister(event) {
    if (event && typeof event.preventDefault === "function") event.preventDefault();

    const form =
        (event && event.target && event.target.tagName === "FORM" && event.target) ||
        (event && event.target && event.target.closest && event.target.closest("form")) ||
        document.getElementById("register-form");
    const statusText =
        document.getElementById("register-form-status") ||
        document.getElementById("reg-camera-status");
    const submitBtn =
        document.getElementById("register-submit-btn") ||
        (form && form.querySelector(".reg-submit, button[type='submit']"));
    const originalBtnText = submitBtn ? submitBtn.innerText : "Kayıt Ol";

    const clearFieldErrors = () => {
        document.querySelectorAll(".field.is-invalid").forEach((el) => el.classList.remove("is-invalid"));
        ["elderly-password-hint", "family-password-hint"].forEach((id) => {
            const hint = document.getElementById(id);
            if (hint) {
                hint.hidden = true;
                hint.textContent = "";
            }
        });
        if (statusText) {
            statusText.classList.remove("is-error", "is-ok", "is-wait");
        }
    };

    const setFieldError = (inputId, hintId, message) => {
        const input = document.getElementById(inputId);
        const field = input?.closest(".field");
        if (field) field.classList.add("is-invalid");
        const confirmInput = document.getElementById(inputId.replace(/-password$/, "-password-confirm")) ||
            (inputId.includes("confirm") ? input : null);
        if (confirmInput?.closest(".field")) confirmInput.closest(".field").classList.add("is-invalid");
        // şifre + tekrar ikisini de işaretle
        if (inputId.includes("password") && !inputId.includes("confirm")) {
            document.getElementById(inputId)?.closest(".field")?.classList.add("is-invalid");
            document.getElementById(inputId + "-confirm")?.closest(".field")?.classList.add("is-invalid");
        }
        const hint = hintId ? document.getElementById(hintId) : null;
        if (hint) {
            hint.hidden = false;
            hint.textContent = message;
        }
    };

    const showStatus = (msg, kind = "error") => {
        if (statusText) {
            statusText.innerText = msg;
            statusText.classList.remove("is-error", "is-ok", "is-wait");
            if (kind === "error") statusText.classList.add("is-error");
            else if (kind === "ok") statusText.classList.add("is-ok");
            else if (kind === "wait") statusText.classList.add("is-wait");
            statusText.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    };

    clearFieldErrors();

    if (typeof window.syncBirthDateHidden === "function") {
        window.syncBirthDateHidden();
    } else {
        const day = document.getElementById("elderly-birth-day")?.value || "";
        const month = document.getElementById("elderly-birth-month")?.value || "";
        const year = document.getElementById("elderly-birth-year")?.value || "";
        const hidden = document.getElementById("elderly-birth-date");
        if (hidden && day && month && year) hidden.value = `${year}-${month}-${day}`;
    }
    if (typeof window.syncFamilyBirthDateHidden === "function") {
        window.syncFamilyBirthDateHidden();
    } else {
        const day = document.getElementById("family-birth-day")?.value || "";
        const month = document.getElementById("family-birth-month")?.value || "";
        const year = document.getElementById("family-birth-year")?.value || "";
        const hidden = document.getElementById("family-birth-date");
        if (hidden && day && month && year) hidden.value = `${year}-${month}-${day}`;
    }

    const digitsOf = (value) =>
        typeof window.phoneDigits === "function"
            ? window.phoneDigits(value)
            : String(value || "").replace(/\D+/g, "");

    const elderlyFirst = document.getElementById("elderly-first-name")?.value.trim() || "";
    const elderlyLast = document.getElementById("elderly-last-name")?.value.trim() || "";
    const elderlyNameLegacy = document.getElementById("elderly-name")?.value.trim() || "";
    const elderlyName = elderlyNameLegacy || `${elderlyFirst} ${elderlyLast}`.trim();
    const elderlyAge = document.getElementById("elderly-age")?.value.trim() || "";
    const elderlyBirth = document.getElementById("elderly-birth-date")?.value || "";
    const elderlyPhone = digitsOf(document.getElementById("elderly-phone")?.value || "");
    const elderlyEmail = document.getElementById("elderly-email")?.value.trim() || "";
    const elderlyPassword = document.getElementById("elderly-password")?.value || "";
    const elderlyPasswordConfirm = document.getElementById("elderly-password-confirm")?.value || "";

    const familyFirst = document.getElementById("family-first-name")?.value.trim() || "";
    const familyLast = document.getElementById("family-last-name")?.value.trim() || "";
    const familyNameLegacy = document.getElementById("family-name")?.value.trim() || "";
    const familyName = familyNameLegacy || `${familyFirst} ${familyLast}`.trim();
    const familyBirth = document.getElementById("family-birth-date")?.value || "";
    const familyPhone = digitsOf(document.getElementById("family-phone")?.value || "");
    const familyEmail = document.getElementById("family-email")?.value.trim() || "";
    const familyPassword = document.getElementById("family-password")?.value || "";
    const familyPasswordConfirm = document.getElementById("family-password-confirm")?.value || "";
    const familyRelationship = document.getElementById("family-relationship")?.value || "";

    if (!elderlyName || !elderlyAge || !familyName || !familyPassword) {
        const msg = "Lütfen ad, soyad, yaş ve şifre alanlarını doldurun.";
        showStatus(msg, "error");
        return;
    }
    if (document.getElementById("elderly-birth-date") && !elderlyBirth) {
        const msg = "Yaşlı doğum tarihini gün / ay / yıl olarak seçin.";
        showStatus(msg, "error");
        return;
    }
    if (document.getElementById("family-birth-date") && !familyBirth) {
        const msg = "Aile doğum tarihini gün / ay / yıl olarak seçin.";
        showStatus(msg, "error");
        return;
    }
    if (!elderlyPhone && !elderlyEmail) {
        const msg = "Yaşlı için telefon veya e-posta girin.";
        showStatus(msg, "error");
        return;
    }
    if (elderlyPhone && elderlyPhone.length < 10) {
        const msg = "Yaşlı telefon numarası 10 haneli olmalıdır.";
        showStatus(msg, "error");
        return;
    }
    if (!familyPhone && !familyEmail) {
        const msg = "Aile için telefon veya e-posta girin.";
        showStatus(msg, "error");
        return;
    }
    if (familyPhone && familyPhone.length < 10) {
        const msg = "Aile telefon numarası 10 haneli olmalıdır.";
        showStatus(msg, "error");
        return;
    }
    if (document.getElementById("family-relationship") && !familyRelationship) {
        const msg = "Yakınlık derecesini seçin.";
        showStatus(msg, "error");
        return;
    }

    // Şifre kontrollerini birlikte topla — iki taraf da kullanıcıya görünsün
    const passwordErrors = [];
    if (document.getElementById("elderly-password")) {
        if (elderlyPassword.length < 6) {
            passwordErrors.push("Yaşlı şifresi en az 6 karakter olmalı.");
            setFieldError("elderly-password", "elderly-password-hint", "En az 6 karakter yazın.");
        } else if (elderlyPassword !== elderlyPasswordConfirm) {
            passwordErrors.push("Yaşlı şifreleri eşleşmiyor.");
            setFieldError("elderly-password", "elderly-password-hint", "Şifreler aynı değil.");
            document.getElementById("elderly-password")?.closest(".field")?.classList.add("is-invalid");
            document.getElementById("elderly-password-confirm")?.closest(".field")?.classList.add("is-invalid");
        }
    }
    if (familyPassword.length < 6) {
        passwordErrors.push("Aile şifresi en az 6 karakter olmalı.");
        setFieldError("family-password", "family-password-hint", "En az 6 karakter yazın.");
    } else if (
        document.getElementById("family-password-confirm") &&
        familyPassword !== familyPasswordConfirm
    ) {
        passwordErrors.push("Aile şifreleri eşleşmiyor.");
        setFieldError("family-password", "family-password-hint", "Şifreler aynı değil.");
        document.getElementById("family-password")?.closest(".field")?.classList.add("is-invalid");
        document.getElementById("family-password-confirm")?.closest(".field")?.classList.add("is-invalid");
    }
    if (passwordErrors.length) {
        showStatus(passwordErrors.join(" "), "error");
        return;
    }

    const faceEnabled = document.getElementById("face-enable")?.checked;
    if (faceEnabled && registeredFaceImages.length > 0 && registeredFaceImages.length < 3) {
        const msg = "Yüz kaydı yarım. 3 açıyı tamamlayın veya 'Yüzü atla' deyin.";
        showStatus(msg, "error");
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = "Kaydediliyor...";
    }
    showStatus("Kayıt gönderiliyor...", "wait");

    try {
        // Yüz analizi (DeepFace) kaydı bloke etmesin — başarısızsa kimlikle devam
        let faceVector = null;
        if (registeredFaceImages.length > 0 || registeredBase64Image) {
            try {
                showStatus("Yüz kaydı işleniyor (opsiyonel)...", "wait");
                const faceResult = await tryExtractFaceVector(statusText);
                if (faceResult && faceResult !== "ABORT") {
                    faceVector = faceResult;
                } else {
                    showStatus("Yüz olmadan kimlik bilgileriyle kayıt devam ediyor...", "wait");
                }
            } catch (faceErr) {
                console.warn("Yüz analizi atlandı:", faceErr);
                showStatus("Yüz olmadan kayıt devam ediyor...", "wait");
            }
        }

        const payload = {
            elderly: {
                name: elderlyName,
                first_name: elderlyFirst || null,
                last_name: elderlyLast || null,
                birth_date: elderlyBirth || null,
                age: parseInt(elderlyAge, 10) || 0,
                phone: elderlyPhone || null,
                email: elderlyEmail || null,
                password: elderlyPassword || null,
                password_confirm: elderlyPasswordConfirm || elderlyPassword || null,
                face_vector: faceVector,
            },
            family: {
                name: familyName,
                first_name: familyFirst || null,
                last_name: familyLast || null,
                birth_date: familyBirth || null,
                relationship: familyRelationship || null,
                phone: familyPhone || null,
                email: familyEmail || null,
                password: familyPassword,
                password_confirm: familyPasswordConfirm || familyPassword,
            },
        };

        const apiUrl = `${API_BASE_URL}/auth/register`;
        console.log("[register] POST", apiUrl, payload);

        const response = await fetchWithTimeout(
            apiUrl,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            },
            REGISTER_TIMEOUT_MS
        );

        let resultData = {};
        try {
            resultData = await response.json();
        } catch (_) {
            resultData = {};
        }

        if (response.ok && resultData.success !== false) {
            const okMsg = resultData.message || "Kayıt tamamlandı. Giriş ekranına yönlendiriliyorsunuz...";
            showStatus("✔️ " + okMsg, "ok");
            if (typeof clearStaleSessionKeys === "function") clearStaleSessionKeys();
            localStorage.setItem("needs_profile_setup", "1");
            window.location.assign("login.html");
            return;
        }

        const detail = resultData.detail;
        const msg = typeof detail === "string" ? detail : (detail ? JSON.stringify(detail) : "Hata oluştu.");
        showStatus("❌ Kayıt hatası: " + msg, "error");
    } catch (error) {
        console.error("Kayıt hatası:", error);
        const msg =
            error.name === "AbortError"
                ? "Kayıt isteği zaman aşımına uğradı. Backend çalışıyor mu?"
                : "Sunucu bağlantısı kurulamadı. Backend açık mı? (" + API_BASE_URL + ")";
        showStatus("❌ " + msg, "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = originalBtnText || "Kayıt Ol";
        }
    }
}

window.handleRegister = handleRegister;
