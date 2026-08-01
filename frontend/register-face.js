/**
 * Opsiyonel yüz kayıt: kılavuz kare, poz bazlı yeşil/kırmızı, ses, ön→sağ→sol.
 * Yaşlı kullanıcıya tek net yön: yaklaş / geriye git / çevir / bas.
 */
const FACE_STEPS = [
    {
        key: "front",
        label: "Ön",
        pose: "front",
        speak: "Kamera açıldı. Lütfen kameraya bakın. Ben size yaklaşın veya geriye gidin diyeceğim. Kare yeşil olunca Fotoğrafı yakala butonuna basın.",
        prompt: "Kameraya bakın. Ben yönlendireceğim.",
    },
    {
        key: "right",
        label: "Sağ",
        pose: "right",
        speak: "Şimdi kafanızı yavaşça sağa çevirin. Kare yeşil olunca Fotoğrafı yakala butonuna basın.",
        prompt: "Kafanızı yavaşça sağa çevirin.",
    },
    {
        key: "left",
        label: "Sol",
        pose: "left",
        speak: "Şimdi kafanızı yavaşça sola çevirin. Kare yeşil olunca Fotoğrafı yakala butonuna basın.",
        prompt: "Kafanızı yavaşça sola çevirin.",
    },
];

const FACE_MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model";
const GUIDE_VOICE = {
    near: "Lütfen kameraya biraz yaklaşın.",
    far: "Lütfen biraz geriye gidin.",
    center: "Yüzünüzü karenin ortasına getirin.",
    noface: "Kameraya bakın. Yüzünüz görünsün.",
    front: "Kameraya düz bakın.",
    right: "Kafanızı yavaşça sağa çevirin.",
    "right-much": "Biraz daha az çevirin.",
    left: "Kafanızı yavaşça sola çevirin.",
    "left-much": "Biraz daha az çevirin.",
    ready: "Harika. Kare yeşil. Fotoğrafı yakala butonuna basın.",
    search: "Yüzünüz aranıyor. Kameraya bakın.",
};
let faceModelsReady = false;
let faceDetectLoop = 0;
let faceReadyToCapture = false;
let faceEnrollmentDone = false;
let lastSpeakKey = "";

function speak(text) {
    try {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = "tr-TR";
        utter.rate = 0.95;
        window.speechSynthesis.speak(utter);
    } catch (_) {
        /* sessiz */
    }
}

function speakOnce(key, text) {
    if (lastSpeakKey === key) return;
    lastSpeakKey = key;
    speak(text);
}

function setPrompt(text, color) {
    const el = document.getElementById("cam-prompt");
    if (!el) return;
    el.textContent = text;
    el.style.color = color || "var(--ink)";
}

function updateStepChips() {
    FACE_STEPS.forEach((step, index) => {
        const chip = document.getElementById(`step-${step.key}`);
        if (!chip) return;
        chip.classList.toggle("active", index === faceCaptureIndex);
        chip.classList.toggle(
            "done",
            registeredFaceImages.some((s) => s.key === step.key)
        );
    });
}

function clearCameraStatus() {
    const status = document.getElementById("reg-camera-status");
    if (status) {
        status.textContent = "";
        status.style.color = "";
    }
}

function resetFaceGuide(hidden = false) {
    const guide = document.getElementById("face-guide");
    if (!guide) return;
    guide.hidden = hidden;
    guide.classList.remove("is-good");
    guide.classList.add("is-bad");
}

function toggleFaceEnrollment(enabled) {
    const panel = document.getElementById("face-panel");
    if (!panel) return;
    if (!enabled) {
        skipFaceEnrollment(false, { uncheck: false });
        return;
    }
    panel.classList.add("is-open");
    clearCameraStatus();
    lastSpeakKey = "";
    lastGuideCode = "";
    faceCaptureIndex = 0;
    faceEnrollmentDone = false;
    registeredFaceImages = [];
    registeredBase64Image = null;
    if (typeof renderFaceThumbs === "function") renderFaceThumbs();
    updateStepChips();
    setPrompt("Kamerayı açın. Ön → sağ → sol olmak üzere 3 açı kaydedilecek.");
    speak("Hızlı giriş için yüz kaydı. Kamerayı açın.");
}

function skipFaceEnrollment(speakMsg = true, options = {}) {
    const shouldUncheck = options.uncheck !== false;
    registeredFaceImages = [];
    registeredBase64Image = null;
    faceCaptureIndex = 0;
    faceEnrollmentDone = false;
    faceReadyToCapture = false;
    lastSpeakKey = "";
    lastGuideCode = "";
    stopRegisterCamera();
    stopFaceDetectLoop();

    const enable = document.getElementById("face-enable");
    if (shouldUncheck && enable) enable.checked = false;
    const panel = document.getElementById("face-panel");
    if (panel) panel.classList.remove("is-open");

    resetFaceGuide(true);
    const video = document.getElementById("reg-webcam");
    const preview = document.getElementById("reg-preview");
    if (video) video.classList.remove("is-on");
    if (preview) preview.classList.remove("is-on");
    const captureBtn = document.getElementById("reg-cam-capture-btn");
    const continueBtn = document.getElementById("reg-cam-continue-btn");
    const openBtn = document.getElementById("reg-cam-open-btn");
    if (captureBtn) {
        captureBtn.style.display = "none";
        captureBtn.disabled = true;
    }
    if (continueBtn) continueBtn.style.display = "none";
    if (openBtn) {
        openBtn.style.display = "inline-flex";
        openBtn.textContent = "Kamerayı aç";
    }
    if (typeof renderFaceThumbs === "function") renderFaceThumbs();
    updateStepChips();
    clearCameraStatus();
    if (speakMsg) speak("Yüz kaydı atlandı.");
    setPrompt("Yüz kaydı kapalı. İsterseniz tekrar açabilirsiniz.");
}

function finishFaceEnrollment() {
    faceEnrollmentDone = true;
    stopRegisterCamera();
    stopFaceDetectLoop();
    const guide = document.getElementById("face-guide");
    if (guide) guide.hidden = true;
    setPrompt("3 açı kaydedildi. Aşağıdan Kayıt Ol ile devam edin.");
    speakOnce("done", "Üç açı kaydedildi. Kayıt ol butonuna basabilirsiniz.");
    const status = document.getElementById("reg-camera-status");
    if (status) {
        status.textContent = "Yüz kaydı tamam. Kayıt Ol’a basabilirsiniz.";
        status.style.color = "var(--ok)";
    }
}

async function ensureFaceModels() {
    if (faceModelsReady) return true;
    if (typeof faceapi === "undefined") return false;
    try {
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
            faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODEL_URL),
        ]);
        faceModelsReady = true;
        return true;
    } catch (error) {
        console.warn("Yüz modeli yüklenemedi:", error);
        return false;
    }
}

function stopFaceDetectLoop() {
    if (faceDetectLoop) {
        clearTimeout(faceDetectLoop);
        faceDetectLoop = 0;
    }
    faceDetectBusy = false;
}

/** object-fit: cover için ekran ↔ video koordinat dönüşümü */
function videoCoverMap(video) {
    const vr = video.getBoundingClientRect();
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const elW = Math.max(vr.width, 1);
    const elH = Math.max(vr.height, 1);
    const scale = Math.max(elW / vw, elH / vh);
    const dispW = vw * scale;
    const dispH = vh * scale;
    return {
        vr,
        vw,
        vh,
        scale,
        offsetX: (elW - dispW) / 2,
        offsetY: (elH - dispH) / 2,
    };
}

function guideRect(video) {
    const guide = document.getElementById("face-guide");
    if (!guide || !video || guide.hidden) return null;
    const m = videoCoverMap(video);
    const gr = guide.getBoundingClientRect();
    const gx = gr.left - m.vr.left;
    const gy = gr.top - m.vr.top;
    return {
        x: (gx - m.offsetX) / m.scale,
        y: (gy - m.offsetY) / m.scale,
        w: gr.width / m.scale,
        h: gr.height / m.scale,
    };
}

function estimateYaw(detection) {
    if (!detection?.landmarks) return null;
    try {
        const nose = detection.landmarks.getNose();
        const leftEye = detection.landmarks.getLeftEye();
        const rightEye = detection.landmarks.getRightEye();
        if (!nose?.length || !leftEye?.length || !rightEye?.length) return null;

        const noseTip = nose[3] || nose[Math.floor(nose.length / 2)];
        const leftCx = leftEye.reduce((s, p) => s + p.x, 0) / leftEye.length;
        const rightCx = rightEye.reduce((s, p) => s + p.x, 0) / rightEye.length;
        const midEyes = (leftCx + rightCx) / 2;
        const faceW = Math.max(detection.box.width, 1);
        return (noseTip.x - midEyes) / faceW;
    } catch (_) {
        return null;
    }
}

/** Mesafe + poz: yaşlıya tek net komut verir */
function evaluateFace(detection, video, pose) {
    if (!detection?.box) {
        return {
            ok: false,
            reason: "Kameraya bakın. Yüzünüz görünsün.",
            code: "noface",
        };
    }

    const guide = guideRect(video);
    const box = detection.box;
    const vw = video.videoWidth || 1;

    // CSS scaleX(-1) ayna: görünen konum için kutuyu yatay çevir
    const face = {
        x: vw - box.x - box.width,
        y: box.y,
        w: box.width,
        h: box.height,
    };

    // İdeal yüz genişliği ≈ karenin %55–%75'i — sistem mesafe ayarlatır
    const refW = guide?.w || vw * 0.8;
    const sizeRatio = face.w / Math.max(refW, 1);

    if (sizeRatio < 0.42) {
        return { ok: false, reason: "Lütfen kameraya biraz yaklaşın.", code: "near" };
    }
    if (sizeRatio > 0.88) {
        return { ok: false, reason: "Lütfen biraz geriye gidin.", code: "far" };
    }

    if (guide) {
        const faceCx = face.x + face.w / 2;
        const faceCy = face.y + face.h / 2;
        const guideCx = guide.x + guide.w / 2;
        const guideCy = guide.y + guide.h / 2;
        const dx = faceCx - guideCx;
        const dy = faceCy - guideCy;
        const tolX = guide.w * 0.4;
        const tolY = guide.h * 0.4;
        if (Math.abs(dx) > tolX || Math.abs(dy) > tolY) {
            return {
                ok: false,
                reason: "Yüzünüzü karenin ortasına getirin.",
                code: "center",
            };
        }
    }

    const yaw = estimateYaw(detection);

    if (pose === "front") {
        if (yaw != null && Math.abs(yaw) > 0.2) {
            return { ok: false, reason: "Kameraya düz bakın.", code: "front" };
        }
        return { ok: true, reason: "Hazır! Fotoğrafı yakala butonuna basın.", code: "ready" };
    }

    // Landmark yoksa yan açı için mesafeyi kabul edip kullanıcıyı sese bırak
    if (yaw == null) {
        return { ok: true, reason: "Hazır! Fotoğrafı yakala butonuna basın.", code: "ready" };
    }

    if (pose === "right") {
        if (yaw > -0.05) {
            return { ok: false, reason: "Kafanızı yavaşça sağa çevirin.", code: "right" };
        }
        if (yaw < -0.45) {
            return { ok: false, reason: "Biraz daha az çevirin.", code: "right-much" };
        }
        return { ok: true, reason: "Hazır! Fotoğrafı yakala butonuna basın.", code: "ready" };
    }
    if (pose === "left") {
        if (yaw < 0.05) {
            return { ok: false, reason: "Kafanızı yavaşça sola çevirin.", code: "left" };
        }
        if (yaw > 0.45) {
            return { ok: false, reason: "Biraz daha az çevirin.", code: "left-much" };
        }
        return { ok: true, reason: "Hazır! Fotoğrafı yakala butonuna basın.", code: "ready" };
    }
    return { ok: true, reason: "Hazır! Fotoğrafı yakala butonuna basın.", code: "ready" };
}

/** Önce landmark, olmazsa sadece kutu — hata mesajı göstermeden devam */
async function detectFaceSafe(video) {
    const opts = new faceapi.TinyFaceDetectorOptions({
        inputSize: 320,
        scoreThreshold: 0.15,
    });
    try {
        const withLandmarks = await faceapi
            .detectSingleFace(video, opts)
            .withFaceLandmarks(true);
        if (withLandmarks) return withLandmarks;
    } catch (err) {
        console.warn("Landmark analizi atlandı:", err);
    }
    try {
        return await faceapi.detectSingleFace(video, opts);
    } catch (err) {
        console.warn("Yüz kutusu alınamadı:", err);
        return null;
    }
}

let faceDetectBusy = false;
let lastGuideCode = "";
let lastGuideSpokenAt = 0;

function speakGuide(code) {
    const text = GUIDE_VOICE[code];
    if (!text) return;
    const now = Date.now();
    // Aynı uyarıyı en erken 3.5 sn'de bir tekrarla (yaşlı için hatırlatma)
    if (code === lastGuideCode && now - lastGuideSpokenAt < 3500) return;
    lastGuideCode = code;
    lastGuideSpokenAt = now;
    speak(text);
}

async function faceDetectTick() {
    const video = document.getElementById("reg-webcam");
    const guide = document.getElementById("face-guide");
    const captureBtn = document.getElementById("reg-cam-capture-btn");

    const scheduleNext = () => {
        faceDetectLoop = setTimeout(() => {
            faceDetectTick();
        }, 200);
    };

    if (!video || !registerStream || video.readyState < 2) {
        scheduleNext();
        return;
    }
    if (faceDetectBusy) {
        scheduleNext();
        return;
    }

    const step = FACE_STEPS[faceCaptureIndex] || FACE_STEPS[0];
    let result = { ok: false, reason: GUIDE_VOICE.search, code: "search" };

    faceDetectBusy = true;
    try {
        if (faceModelsReady && typeof faceapi !== "undefined") {
            const detection = await detectFaceSafe(video);
            result = evaluateFace(detection, video, step.pose);
        } else {
            result = {
                ok: false,
                reason: "Kameraya bakın. Model yükleniyor…",
                code: "search",
            };
        }
    } catch (err) {
        console.warn("Yüz analizi hatası:", err);
        result = {
            ok: false,
            reason: "Kameraya bakın. Yüzünüz görünsün.",
            code: "noface",
        };
    } finally {
        faceDetectBusy = false;
    }

    faceReadyToCapture = result.ok;
    if (guide) {
        guide.classList.toggle("is-good", result.ok);
        guide.classList.toggle("is-bad", !result.ok);
    }
    if (captureBtn) captureBtn.disabled = !result.ok;

    setPrompt(result.reason, result.ok ? "var(--ok)" : "var(--bad)");
    speakGuide(result.code);

    scheduleNext();
}

async function openRegisterCamera() {
    const video = document.getElementById("reg-webcam");
    const preview = document.getElementById("reg-preview");
    const statusText = document.getElementById("reg-camera-status");
    if (!video) return;

    if (registeredFaceImages.length >= FACE_STEPS.length) {
        registeredFaceImages = [];
        faceCaptureIndex = 0;
        faceEnrollmentDone = false;
        if (typeof renderFaceThumbs === "function") renderFaceThumbs();
    }

    try {
        stopRegisterCamera();
        stopFaceDetectLoop();
        registerStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: "user",
            },
            audio: false,
        });
        video.srcObject = registerStream;
        await video.play();
        video.classList.add("is-on");
        if (preview) preview.classList.remove("is-on");
        resetFaceGuide(false);
        faceReadyToCapture = false;
        lastGuideCode = "";
        lastGuideSpokenAt = 0;
        clearCameraStatus();

        const captureBtn = document.getElementById("reg-cam-capture-btn");
        const continueBtn = document.getElementById("reg-cam-continue-btn");
        const openBtn = document.getElementById("reg-cam-open-btn");
        if (captureBtn) {
            captureBtn.style.display = "inline-flex";
            captureBtn.disabled = true;
        }
        if (continueBtn) continueBtn.style.display = "none";
        if (openBtn) openBtn.style.display = "none";

        updateStepChips();
        const step = FACE_STEPS[faceCaptureIndex];
        lastSpeakKey = "";
        setPrompt(step.prompt);
        speak(step.speak);
        if (statusText) {
            statusText.textContent = `${step.label} açısı — yönlendirmeyi izleyin.`;
            statusText.style.color = "";
        }

        const ok = await ensureFaceModels();
        if (!ok && statusText) {
            statusText.textContent = "Yüz modeli yüklenemedi; yine de çekim yapabilirsiniz.";
            faceReadyToCapture = true;
            const guide = document.getElementById("face-guide");
            if (guide) {
                guide.classList.add("is-good");
                guide.classList.remove("is-bad");
            }
            const captureBtnFallback = document.getElementById("reg-cam-capture-btn");
            if (captureBtnFallback) captureBtnFallback.disabled = false;
        }
        faceDetectLoop = setTimeout(() => faceDetectTick(), 120);
    } catch (err) {
        setPrompt("Kamera izni verilmedi veya kamera bulunamadı.", "var(--bad)");
        speak("Kamera açılamadı. Lütfen izin verin.");
    }
}

function captureRegisterFace() {
    const video = document.getElementById("reg-webcam");
    const preview = document.getElementById("reg-preview");
    if (!video || !registerStream) return;
    if (!faceReadyToCapture && faceModelsReady) {
        speak("Henüz hazır değil. Çerçeve yeşil olunca deneyin.");
        return;
    }

    const step = FACE_STEPS[faceCaptureIndex] || FACE_STEPS[0];
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);

    registeredBase64Image = dataUrl;
    registeredFaceImages = registeredFaceImages.filter((s) => s.key !== step.key);
    registeredFaceImages.push({ key: step.key, label: step.label, dataUrl });
    if (typeof renderFaceThumbs === "function") renderFaceThumbs();
    updateStepChips();

    stopFaceDetectLoop();
    stopRegisterCamera();
    video.classList.remove("is-on");
    if (preview) {
        preview.src = dataUrl;
        preview.classList.add("is-on");
    }
    resetFaceGuide(true);

    const captureBtn = document.getElementById("reg-cam-capture-btn");
    const openBtn = document.getElementById("reg-cam-open-btn");
    const continueBtn = document.getElementById("reg-cam-continue-btn");
    if (captureBtn) {
        captureBtn.style.display = "none";
        captureBtn.disabled = true;
    }

    const done = registeredFaceImages.length >= FACE_STEPS.length;
    if (done) {
        if (openBtn) openBtn.style.display = "none";
        if (continueBtn) continueBtn.style.display = "inline-flex";
        clearCameraStatus();
        setPrompt("3 fotoğraf kaydedildi. Devam’a basın.", "var(--ok)");
        speak("Üç fotoğraf kaydedildi. Devam butonuna basın.");
        return;
    }

    // Sonraki açı: kareyi sıfırla (kırmızı), yeni poz için kamerayı aç
    faceCaptureIndex = registeredFaceImages.length;
    faceReadyToCapture = false;
    lastGuideCode = "";
    lastSpeakKey = "";
    updateStepChips();
    const next = FACE_STEPS[faceCaptureIndex];
    setPrompt(`${step.label} kaydedildi. Sırada: ${next.label}.`, "var(--ok)");
    speak(`${step.label} kaydedildi. ${next.speak}`);
    if (openBtn) openBtn.style.display = "none";
    setTimeout(() => {
        if (registeredFaceImages.length < FACE_STEPS.length) {
            openRegisterCamera();
        }
    }, 1100);
}

function formatTrPhoneDisplay(raw) {
    const digits = String(raw || "").replace(/\D+/g, "").slice(0, 10);
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
    if (digits.length <= 8) {
        return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 8)} ${digits.slice(8)}`;
}

function phoneDigits(value) {
    return String(value || "").replace(/\D+/g, "");
}

function bindPhoneMask(input) {
    if (!input) return;
    input.addEventListener("input", () => {
        const formatted = formatTrPhoneDisplay(input.value);
        input.value = formatted;
    });
}

function syncBirthDateHidden() {
    const day = document.getElementById("elderly-birth-day")?.value || "";
    const month = document.getElementById("elderly-birth-month")?.value || "";
    const year = document.getElementById("elderly-birth-year")?.value || "";
    const hidden = document.getElementById("elderly-birth-date");
    const age = document.getElementById("elderly-age");
    if (!hidden) return;
    if (day && month && year) {
        hidden.value = `${year}-${month}-${day}`;
        const d = new Date(`${year}-${month}-${day}T00:00:00`);
        if (!Number.isNaN(d.getTime()) && age) {
            const now = new Date();
            let years = now.getFullYear() - d.getFullYear();
            const m = now.getMonth() - d.getMonth();
            if (m < 0 || (m === 0 && now.getDate() < d.getDate())) years -= 1;
            if (years > 0 && years < 130) age.value = String(years);
        }
    } else {
        hidden.value = "";
    }
}

function syncFamilyBirthDateHidden() {
    const day = document.getElementById("family-birth-day")?.value || "";
    const month = document.getElementById("family-birth-month")?.value || "";
    const year = document.getElementById("family-birth-year")?.value || "";
    const hidden = document.getElementById("family-birth-date");
    if (!hidden) return;
    hidden.value = day && month && year ? `${year}-${month}-${day}` : "";
}

function fillDayYearSelects(dayId, yearId, minAge, maxAge) {
    const daySel = document.getElementById(dayId);
    const yearSel = document.getElementById(yearId);
    if (daySel && daySel.options.length <= 1) {
        for (let d = 1; d <= 31; d += 1) {
            const v = String(d).padStart(2, "0");
            const opt = document.createElement("option");
            opt.value = v;
            opt.textContent = String(d);
            daySel.appendChild(opt);
        }
    }
    if (yearSel && yearSel.options.length <= 1) {
        const nowY = new Date().getFullYear();
        for (let y = nowY - minAge; y >= nowY - maxAge; y -= 1) {
            const opt = document.createElement("option");
            opt.value = String(y);
            opt.textContent = String(y);
            yearSel.appendChild(opt);
        }
    }
}

function bindRegisterHelpers() {
    fillDayYearSelects("elderly-birth-day", "elderly-birth-year", 40, 110);
    fillDayYearSelects("family-birth-day", "family-birth-year", 18, 100);

    ["elderly-birth-day", "elderly-birth-month", "elderly-birth-year"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", syncBirthDateHidden);
    });
    ["family-birth-day", "family-birth-month", "family-birth-year"].forEach((id) => {
        document.getElementById(id)?.addEventListener("change", syncFamilyBirthDateHidden);
    });

    bindPhoneMask(document.getElementById("elderly-phone"));
    bindPhoneMask(document.getElementById("family-phone"));

    const bindPasswordMatch = (passId, confirmId, hintId, label) => {
        const pass = document.getElementById(passId);
        const confirm = document.getElementById(confirmId);
        const hint = document.getElementById(hintId);
        if (!pass || !confirm || !hint) return;
        const check = () => {
            const a = pass.value;
            const b = confirm.value;
            pass.closest(".field")?.classList.remove("is-invalid");
            confirm.closest(".field")?.classList.remove("is-invalid");
            if (!b) {
                hint.hidden = true;
                hint.textContent = "";
                return;
            }
            if (a !== b) {
                hint.hidden = false;
                hint.textContent = `${label} şifreleri eşleşmiyor.`;
                pass.closest(".field")?.classList.add("is-invalid");
                confirm.closest(".field")?.classList.add("is-invalid");
            } else {
                hint.hidden = true;
                hint.textContent = "";
            }
        };
        pass.addEventListener("input", check);
        confirm.addEventListener("input", check);
    };
    bindPasswordMatch("elderly-password", "elderly-password-confirm", "elderly-password-hint", "Yaşlı");
    bindPasswordMatch("family-password", "family-password-confirm", "family-password-hint", "Aile");

    const form = document.getElementById("register-form");
    const submitBtn = document.getElementById("register-submit-btn");
    if (form && !form.dataset.boundRegister) {
        form.dataset.boundRegister = "1";
        form.addEventListener("submit", (ev) => {
            if (typeof window.handleRegister === "function") window.handleRegister(ev);
        });
    }
    if (submitBtn && !submitBtn.dataset.boundRegister) {
        submitBtn.dataset.boundRegister = "1";
        submitBtn.addEventListener("click", (ev) => {
            ev.preventDefault();
            if (typeof window.handleRegister === "function") {
                window.handleRegister(ev);
            } else {
                const status = document.getElementById("register-form-status");
                if (status) {
                    status.classList.add("is-error");
                    status.textContent = "Kayıt scripti yüklenemedi. Sayfayı Ctrl+F5 ile yenileyin.";
                }
            }
        });
    }
}

function bootRegisterPage() {
    if (!document.getElementById("register-form")) return;
    bindRegisterHelpers();
    window.openRegisterCamera = openRegisterCamera;
    window.captureRegisterFace = captureRegisterFace;
    window.toggleFaceEnrollment = toggleFaceEnrollment;
    window.skipFaceEnrollment = skipFaceEnrollment;
    window.finishFaceEnrollment = finishFaceEnrollment;
    window.phoneDigits = phoneDigits;
    window.formatTrPhoneDisplay = formatTrPhoneDisplay;
    window.syncBirthDateHidden = syncBirthDateHidden;
    window.syncFamilyBirthDateHidden = syncFamilyBirthDateHidden;
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootRegisterPage);
} else {
    bootRegisterPage();
}
