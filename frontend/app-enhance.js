/**
 * Kiosk app enhancements — ses çubukları, TTS, resim, profil, snooze limiti, ilaç sekmeleri.
 * app.js üzerine bağlanır (aynı global fonksiyonları genişletir).
 */
(function () {
    const MAX_SNOOZES = 3;
    let pendingChatImage = null;
    let audioCtx = null;
    let analyser = null;
    let meterRaf = 0;
    let baseSwitchPage = null;
    let peakLevel = 0;

    function apiBase() {
        return (
            window.API_BASE_URL ||
            (window.CONFIG && CONFIG.API_BASE_URL) ||
            "http://127.0.0.1:8000/api"
        );
    }

    function speakTurkish(text) {
        if (!("speechSynthesis" in window) || !text) return;
        try {
            window.speechSynthesis.cancel();
            const msg = new SpeechSynthesisUtterance(String(text));
            msg.lang = "tr-TR";
            msg.rate = 0.92;
            window.speechSynthesis.speak(msg);
        } catch (_) { /* ignore */ }
    }
    window.speakTurkish = speakTurkish;

    function setVoiceUi(recording, statusText) {
        const bars = document.getElementById("voiceBars");
        const hint = document.getElementById("voiceHint");
        const btnText = document.getElementById("btnText");
        if (bars) {
            bars.classList.toggle("is-on", Boolean(recording));
            bars.classList.toggle("is-live", Boolean(recording));
        }
        if (hint) {
            hint.textContent = statusText
                || (recording
                    ? "Dinliyorum… Bitince aynı butona tekrar basın."
                    : "Başlatmak için basın, konuşun, bitince tekrar basın.");
        }
        if (btnText) {
            btnText.textContent = recording
                ? "Dinliyorum — Bitirmek için basın"
                : "Konuşmak İçin Basın";
        }
    }

    function stopMeter() {
        if (meterRaf) cancelAnimationFrame(meterRaf);
        meterRaf = 0;
        if (audioCtx) {
            try { audioCtx.close(); } catch (_) { /* ignore */ }
            audioCtx = null;
            analyser = null;
        }
    }

    function startMeter(mediaStream) {
        stopMeter();
        try {
            // ÖNEMLİ: ölçer için stream klonu — MediaRecorder ile aynı track paylaşmak
            // bazı tarayıcılarda sessiz/boş kayıt üretir.
            const meterStream = mediaStream.clone
                ? mediaStream.clone()
                : mediaStream;
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === "suspended") {
                audioCtx.resume().catch(() => {});
            }
            const source = audioCtx.createMediaStreamSource(meterStream);
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.7;
            source.connect(analyser);
            const data = new Uint8Array(analyser.frequencyBinCount);
            const bars = document.querySelectorAll("#voiceBars i");

            const tick = () => {
                if (!analyser) return;
                analyser.getByteFrequencyData(data);
                let sum = 0;
                let max = 0;
                for (let i = 0; i < data.length; i += 1) {
                    sum += data[i];
                    if (data[i] > max) max = data[i];
                }
                const avg = sum / Math.max(data.length, 1);
                if (max > peakLevel) peakLevel = max;
                bars.forEach((el, i) => {
                    const v = data[i * 2] || data[i] || avg;
                    const h = 8 + Math.round((v / 255) * 34);
                    el.style.height = `${h}px`;
                });
                meterRaf = requestAnimationFrame(tick);
            };
            tick();

            // klon track'lerini meter kapanınca durdur
            meterStream._yanimdaMeter = true;
            window._voiceMeterStream = meterStream;
        } catch (err) {
            console.warn("Ses ölçer açılamadı:", err);
        }
    }

    function stopMeterTracks() {
        const meterStream = window._voiceMeterStream;
        if (meterStream && meterStream.getTracks) {
            meterStream.getTracks().forEach((t) => {
                try { t.stop(); } catch (_) { /* ignore */ }
            });
        }
        window._voiceMeterStream = null;
    }

    function enhancedAppendMessage(text, sender, options = {}) {
        const chatBox = document.getElementById("chatBox");
        const chatScroll = document.getElementById("chatScroll");
        if (!chatBox) return;

        const msgDiv = document.createElement("div");
        let styleClass = "user";
        if (sender === "assistant" || sender === "ai" || sender === "system") {
            styleClass = sender === "system" ? "system" : "ai";
        }
        msgDiv.className = `chat-msg msg-${styleClass}`;

        if (options.imageUrl) {
            const img = document.createElement("img");
            img.src = options.imageUrl;
            img.alt = "Yüklenen görsel";
            msgDiv.appendChild(img);
        }
        if (text) {
            const p = document.createElement("div");
            p.textContent = text;
            msgDiv.appendChild(p);
        }

        chatBox.appendChild(msgDiv);
        if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;

        if (styleClass === "ai" && text && !options.silent) {
            speakTurkish(text);
        }
    }

    let voiceStartedAt = 0;
    let voiceChunks = [];
    let voiceMime = "audio/webm";
    let voicePath = null; // "speech" | "whisper"
    let speechRec = null;
    let speechFinal = "";
    let speechFinishing = false;

    function pickRecorderMime() {
        const candidates = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/mp4",
            "audio/ogg;codecs=opus",
        ];
        for (const type of candidates) {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        return "";
    }

    function isBadTranscription(text) {
        const t = String(text || "").trim();
        if (!t) return true;
        const low = t
            .toLocaleLowerCase("tr-TR")
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");
        const junkExact = new Set([
            "altyazi",
            "m.k.",
            "mk.",
            "subtitle",
            "subtitles",
            "thank you",
            "thanks for watching",
            "thank you for watching",
            "abone ol",
            "abone olun",
            "sessizlik",
            ".",
            "..",
            "...",
            "????",
        ]);
        if (junkExact.has(low)) return true;
        const junkPatterns = [
            /izlediginiz\s+icin\s+tesekkur/,
            /izlediginiz\s+icin/,
            /tesekkur(ler)?\s+ederim.*izle/,
            /thanks?\s+for\s+watching/,
            /thank\s+you\s+for\s+watching/,
            /^(altyaz[ıi]|subtitle)/i,
            /\babone\s+ol/,
            /\bbeğenmeyi\b|\bbegenmeyi\b/,
            /\blik[eé]\s+and\s+subscribe/,
            /\bsubscribe\b/,
            /translated\s+by/,
            /amara\.org/,
            /m\.?\s*k\.?\s*$/i,
        ];
        if (junkPatterns.some((re) => re.test(low))) return true;
        if (t.length < 2) return true;
        return false;
    }

    function extensionForMime(mime) {
        if (!mime) return "webm";
        if (mime.includes("mp4")) return "mp4";
        if (mime.includes("ogg")) return "ogg";
        if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
        if (mime.includes("wav")) return "wav";
        return "webm";
    }

    function stopMeterPeakTrack() {
        peakLevel = 0;
    }

    async function postHeardText(heard) {
        const voiceBtn = document.getElementById("voiceBtn");
        setVoiceUi(false, "Yanıt hazırlanıyor…");
        if (voiceBtn) voiceBtn.disabled = true;
        try {
            const elderId = typeof getOwnerElderId === "function" ? getOwnerElderId() : null;
            const response = await fetch(`${apiBase()}/text-chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    conversation_id: window.activeChatId,
                    message: heard,
                    user_id: window.realUserId || null,
                    user_name: window.userDisplayName || "",
                    elder_id: elderId,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.detail || "Sohbet yanıtı alınamadı");
            }
            appendMessageToUI(heard, "user");
            appendMessageToUI(data.ai_response || "Anladım.", "ai");
            if (typeof loadConversationsFromSupabase === "function") {
                await loadConversationsFromSupabase();
            }
            if (data.escalation) {
                try {
                    if (typeof logActivity === "function") {
                        logActivity("chat", { channel: "voice", escalation: true });
                    }
                } catch (_) { /* ignore */ }
            }
        } catch (err) {
            console.error(err);
            appendMessageToUI(
                "Yanıt alınamadı. Backend çalışıyor mu kontrol edin.",
                "ai"
            );
        } finally {
            if (voiceBtn) voiceBtn.disabled = false;
            setVoiceUi(false);
        }
    }

    async function finishSpeechCapture() {
        if (speechFinishing) return;
        speechFinishing = true;
        const voiceBtn = document.getElementById("voiceBtn");
        window.isRecording = false;
        voicePath = null;
        stopMeter();
        stopMeterTracks();
        if (window.stream) {
            window.stream.getTracks?.().forEach((t) => {
                try { t.stop(); } catch (_) { /* ignore */ }
            });
            window.stream = null;
        }
        voiceBtn?.classList.remove("recording");

        const heard = String(speechFinal || "").trim();
        speechFinal = "";
        speechRec = null;

        console.info("[voice] speech API sonuç", { heard, peak: peakLevel, elapsed: Date.now() - voiceStartedAt });

        const elapsed = Date.now() - voiceStartedAt;
        if (elapsed < 500 && !heard) {
            appendMessageToUI(
                "Kayıt çok kısa kaldı. Butona basıp en az 1–2 saniye konuşun, bitince tekrar basın.",
                "ai"
            );
            setVoiceUi(false);
            speechFinishing = false;
            return;
        }

        if (!heard || isBadTranscription(heard)) {
            appendMessageToUI(
                heard
                    ? `Sizi net anlayamadım (${heard}). Mikrofona yakın konuşup tekrar dener misiniz?`
                    : "Sesinizi alamadım. Butona basıp net konuşun, bitince tekrar basın.",
                "ai"
            );
            setVoiceUi(false);
            speechFinishing = false;
            return;
        }

        await postHeardText(heard);
        speechFinishing = false;
    }

    function startSpeechRecognitionPath() {
        const SpeechRecognitionCtor =
            window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognitionCtor) return false;

        speechFinal = "";
        speechFinishing = false;
        const rec = new SpeechRecognitionCtor();
        speechRec = rec;
        rec.lang = "tr-TR";
        rec.interimResults = true;
        rec.continuous = true;
        rec.maxAlternatives = 1;

        rec.onresult = (event) => {
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i += 1) {
                const piece = event.results[i][0]?.transcript || "";
                if (event.results[i].isFinal) {
                    speechFinal = `${speechFinal} ${piece}`.trim();
                } else {
                    interim += piece;
                }
            }
            const preview = (speechFinal || interim || "").trim();
            if (preview) {
                setVoiceUi(true, `Dinliyorum… “${preview.slice(0, 48)}${preview.length > 48 ? "…" : ""}”`);
            }
        };

        rec.onerror = (event) => {
            const code = event?.error || "";
            console.warn("[voice] SpeechRecognition error:", code);
            if (code === "not-allowed" || code === "service-not-allowed") {
                window.isRecording = false;
                try { rec.abort(); } catch (_) { /* ignore */ }
                appendMessageToUI(
                    "Mikrofon izni gerekli. Tarayıcı ayarlarından izin verip tekrar deneyin.",
                    "ai"
                );
                setVoiceUi(false);
                document.getElementById("voiceBtn")?.classList.remove("recording");
                stopMeter();
                stopMeterTracks();
                return;
            }
            // no-speech / network → bitişte boşsa kullanıcıya söyle
            if (code === "network" && !speechFinal) {
                // Chrome network hatası — Whisper'a düş; onend'in boş mesaj basmasını engelle
                speechFinishing = true;
                window.isRecording = false;
                try { rec.abort(); } catch (_) { /* ignore */ }
                setVoiceUi(false);
                document.getElementById("voiceBtn")?.classList.remove("recording");
                stopMeter();
                stopMeterTracks();
                speechRec = null;
                speechFinishing = false;
                appendMessageToUI(
                    "Tarayıcı dinlemesi başarısız. Kayıt moduna geçiliyor — tekrar basın.",
                    "system"
                );
                window._forceWhisperNext = true;
            }
        };

        rec.onend = () => {
            // stop() veya sessizlik kesmesi → sonucu işle
            if (speechFinishing) return;
            window.isRecording = false;
            finishSpeechCapture();
        };

        rec.start();
        voicePath = "speech";
        window.isRecording = true;
        voiceStartedAt = Date.now();
        document.getElementById("voiceBtn")?.classList.add("recording");
        setVoiceUi(true, `Dinliyorum (${voiceModeLabel()})… Konuşun, bitince tekrar basın.`);

        // Sadece seviye çubuğu için mikrofon (kayıt değil)
        if (navigator.mediaDevices?.getUserMedia) {
            navigator.mediaDevices
                .getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                        channelCount: 1,
                    },
                })
                .then((stream) => {
                    window.stream = stream;
                    startMeter(stream);
                })
                .catch(() => { /* meter opsiyonel */ });
        }
        return true;
    }

    async function startWhisperRecorderPath() {
        const voiceBtn = document.getElementById("voiceBtn");
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error("Bu tarayıcı mikrofon desteklemiyor.");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
            },
        });
        window.stream = stream;
        voiceChunks = [];
        window.audioChunks = voiceChunks;
        peakLevel = 0;

        voiceMime = pickRecorderMime();
        const recorderOpts = voiceMime ? { mimeType: voiceMime } : undefined;
        const recorder = new MediaRecorder(stream, recorderOpts);
        window.mediaRecorder = recorder;
        voiceMime = recorder.mimeType || voiceMime || "audio/webm";

        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                voiceChunks.push(event.data);
            }
        };

        recorder.onerror = (event) => {
            console.error("MediaRecorder error:", event.error || event);
        };

        recorder.onstop = async () => {
            const elapsed = Date.now() - voiceStartedAt;
            const capturedPeak = peakLevel;
            stopMeter();
            stopMeterTracks();
            setVoiceUi(false);
            voiceBtn?.classList.remove("recording");
            voicePath = null;

            const audioBlob = new Blob(voiceChunks, { type: voiceMime || "audio/webm" });
            stream.getTracks().forEach((t) => {
                try { t.stop(); } catch (_) { /* ignore */ }
            });

            console.info("[voice] whisper kayıt bitti", {
                elapsedMs: elapsed,
                chunks: voiceChunks.length,
                bytes: audioBlob.size,
                mime: voiceMime,
                peak: capturedPeak,
            });

            if (elapsed < 800 || audioBlob.size < 1200 || voiceChunks.length === 0) {
                appendMessageToUI(
                    "Ses kaydı alınamadı veya çok kısa. En az 1–2 saniye net konuşun, bitince tekrar basın.",
                    "ai"
                );
                return;
            }
            if (capturedPeak < 8) {
                appendMessageToUI(
                    "Mikrofon neredeyse sessiz kaldı. Ses seviyesini açıp mikrofona yakın konuşun.",
                    "ai"
                );
                return;
            }

            setVoiceUi(false, "Ses gönderiliyor, lütfen bekleyin…");
            if (voiceBtn) voiceBtn.disabled = true;

            const ext = extensionForMime(voiceMime);
            const formData = new FormData();
            formData.append("file", audioBlob, `voice.${ext}`);
            formData.append("conversation_id", window.activeChatId);
            if (window.realUserId) formData.append("user_id", window.realUserId);
            formData.append("user_name", window.userDisplayName || "");
            const elderId = typeof getOwnerElderId === "function" ? getOwnerElderId() : null;
            if (elderId) formData.append("elder_id", elderId);

            try {
                const response = await fetch(`${apiBase()}/voice-chat`, {
                    method: "POST",
                    body: formData,
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    throw new Error(data.detail || "Ses işlenemedi");
                }

                const heard = String(data.user_transcription || data.text || "").trim();
                if (heard && !isBadTranscription(heard)) {
                    appendMessageToUI(heard, "user");
                    appendMessageToUI(data.ai_response || "Anladım.", "ai");
                    if (typeof loadConversationsFromSupabase === "function") {
                        await loadConversationsFromSupabase();
                    }
                } else if (heard) {
                    appendMessageToUI(`(Algılanan: ${heard})`, "system");
                    appendMessageToUI(
                        data.ai_response
                            || "Sizi net anlayamadım. Mikrofona biraz daha yakın konuşup tekrar dener misiniz?",
                        "ai"
                    );
                } else {
                    appendMessageToUI(
                        data.ai_response || "Sesinizi alamadım. Lütfen tekrar deneyin.",
                        "ai"
                    );
                }
            } catch (err) {
                console.error(err);
                appendMessageToUI(
                    "Ses sunucuya gönderilemedi. Backend çalışıyor mu kontrol edin.",
                    "ai"
                );
            } finally {
                if (voiceBtn) voiceBtn.disabled = false;
                setVoiceUi(false);
            }
        };

        voiceStartedAt = Date.now();
        try {
            recorder.start(250);
        } catch (_) {
            recorder.start();
        }
        voicePath = "whisper";
        window.isRecording = true;
        voiceBtn?.classList.add("recording");
        setVoiceUi(true, `Kayıt alınıyor (${voiceModeLabel()})… Bitince tekrar basın.`);
        startMeter(stream);
    }

    function supportsSpeechRecognition() {
        return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    function voiceModeLabel() {
        if (supportsSpeechRecognition() && !window._forceWhisperNext) {
            return "Tarayıcı dinleme (Chrome/Edge)";
        }
        return "Kayıt + Whisper (tüm tarayıcılar)";
    }

    async function enhancedToggleVoice() {
        const voiceBtn = document.getElementById("voiceBtn");
        if (!window.isRecording) {
            try {
                if ("speechSynthesis" in window) {
                    window.speechSynthesis.cancel();
                }
                stopMeterPeakTrack();

                const forceLive = Boolean(window._forceLiveSpeech);
                window._forceLiveSpeech = false;

                // Varsayılan: Whisper (Türkçe yaşlı sesinde daha güvenilir)
                // Canlı dinleme yalnızca kullanıcı özellikle isterse
                if (forceLive && startSpeechRecognitionPath()) {
                    return;
                }

                appendMessageToUI(
                    "Kayıt başladı — konuşun, bitince butona tekrar basın.",
                    "system"
                );
                await startWhisperRecorderPath();
            } catch (err) {
                console.error(err);
                appendMessageToUI(
                    "Mikrofon izni gerekli veya mikrofon bulunamadı. Tarayıcı ayarlarından izin verip tekrar deneyin.",
                    "ai"
                );
                setVoiceUi(false);
                voiceBtn?.classList.remove("recording");
            }
            return;
        }

        // Durdur
        window.isRecording = false;
        if (voicePath === "speech" && speechRec) {
            try {
                speechRec.stop();
            } catch (_) {
                finishSpeechCapture();
            }
            return;
        }

        const recorder = window.mediaRecorder;
        if (recorder && recorder.state === "recording") {
            try {
                if (typeof recorder.requestData === "function") recorder.requestData();
            } catch (_) { /* ignore */ }
            recorder.stop();
        } else {
            setVoiceUi(false);
            voiceBtn?.classList.remove("recording");
            stopMeter();
            stopMeterTracks();
        }
    }

    function renderCheckinDone(mood, followUp) {
        const card = document.getElementById("checkinCard");
        if (!card) return;
        card.innerHTML = `
            <span style="font-size:64px;">✔️</span>
            <h2 style="color:var(--ok); font-size:1.6rem; font-weight:800;">Durumunuz Bildirildi</h2>
            <p style="font-size:1.15rem; color:var(--muted); margin-top:6px;">${followUp}</p>
            <p style="font-size:1.1rem; font-weight:700; margin-top:8px;">Kaydedilen: ${mood}</p>
            <button type="button" class="btn btn-ghost" onclick="resetCheckinForm()">Durumu yeniden bildir</button>
        `;
        speakTurkish(followUp);
    }

    window.resetCheckinForm = function resetCheckinForm() {
        const card = document.getElementById("checkinCard");
        const name = window.userDisplayName || "";
        if (!card) return;
        card.innerHTML = `
            <p id="checkinGreeting" class="checkin-greeting">${name ? name + ", " : ""}bugün kendini nasıl hissediyorsun?</p>
            <button type="button" class="btn btn-success" onclick="completeCheckin('Harika!')">😊 Çok İyiyim</button>
            <button type="button" class="btn btn-neutral" onclick="completeCheckin('Normal')">🙂 Normal</button>
            <button type="button" class="btn btn-warn" onclick="completeCheckin('Biraz halsizim')">😐 Biraz Halsizim</button>
        `;
    };

    async function enhancedCompleteCheckin(mood) {
        try {
            const response = await fetch(`${apiBase()}/checkin`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    conversation_id: window.elderProfileId,
                    mood,
                    elder_id: localStorage.getItem("elder_id") || null,
                    user_id: window.realUserId || window.elderProfileId,
                }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                speakTurkish("Durum kaydedilemedi.");
                return;
            }
            const followUp =
                typeof checkinFollowUpMessage === "function"
                    ? checkinFollowUpMessage(mood)
                    : "Durumunuz kaydedildi.";
            renderCheckinDone(mood, followUp);

            const banner = document.getElementById("checkinStatusBanner");
            if (banner) {
                const time = new Date().toLocaleTimeString("tr-TR", {
                    hour: "2-digit",
                    minute: "2-digit",
                });
                banner.innerHTML = `<div style="background:#ECFDF5;border:1px solid #A7F3D0;color:#065F46;border-radius:12px;padding:12px;font-weight:700;text-align:center;">✅ Bugün check-in yapıldı (${time}, ${mood})</div>`;
            }
            appendMessageToUI(`Günlük sağlık kontrolü: ${mood}`, "user");
            if (typeof loadCheckinHistory === "function") loadCheckinHistory();
            if (typeof loadCheckinStatus === "function") loadCheckinStatus();
        } catch (error) {
            console.error(error);
            speakTurkish("Bağlantı hatası.");
        }
    }

    function enhancedShowMedicationAlert(data) {
        if (!window.currentMedAlert || window.currentMedAlert.medication_id !== data.medication_id) {
            data.snoozeCount = data.snoozeCount || 0;
        } else {
            data.snoozeCount = window.currentMedAlert.snoozeCount || 0;
        }
        window.currentMedAlert = data;

        if (typeof switchPage === "function") switchPage("ilaclar");

        const title = document.getElementById("medAlertTitle");
        const desc = document.getElementById("medAlertDesc");
        const info = document.getElementById("medAlertSnoozeInfo");
        const modal = document.getElementById("medicationAlertModal");
        if (title) title.innerText = `${data.ilac_adi} Saati!`;
        const food = String(data.food_timing || "").toLocaleLowerCase("tr-TR");
        let foodHint = "";
        if (food === "aç") foodHint = " Aç karnına almayı unutmayın.";
        else if (food === "tok") foodHint = " Tok karnına almayı unutmayın.";
        if (desc) {
            desc.innerText = `Lütfen doz: ${data.dozaj || "Belirtilmemiş"} ilacınızı alın.${foodHint}`;
        }
        if (info) {
            info.textContent =
                data.snoozeCount > 0
                    ? `Erteleme: ${data.snoozeCount}/${MAX_SNOOZES}`
                    : `En fazla ${MAX_SNOOZES} kez 10 dakika erteleyebilirsiniz.`;
        }
        if (modal) modal.style.display = "flex";
        speakTurkish(`İlaç saatiniz geldi. Lütfen ${data.ilac_adi} ilacınızı alın.${foodHint}`);
    }

    async function enhancedLogMedication(status, method) {
        if (!window.currentMedAlert) return;
        const alert = window.currentMedAlert;

        try {
            const formData = new FormData();
            formData.append("medication_id", alert.medication_id);
            formData.append("status", status);
            formData.append("confirmed_method", method);
            if (alert.schedule_id) formData.append("schedule_id", alert.schedule_id);

            const response = await fetch(`${apiBase()}/medication/log`, {
                method: "POST",
                body: formData,
            });
            const result = await response.json().catch(() => ({}));
            const decision = result?.data?.decision || status;

            document.getElementById("medicationAlertModal").style.display = "none";

            if (decision === "taken" || status === "taken") {
                speakTurkish("Teşekkürler, ilacınızı içtiğiniz kaydedildi.");
                appendMessageToUI(`${alert.ilac_adi} ilacı alındı.`, "system");
                window.currentMedAlert = null;
                if (window.MedicationDefinitions) MedicationDefinitions.refresh();
                return;
            }

            if (decision === "missed") {
                speakTurkish("İlaç içilmedi olarak kaydedildi. Aileniz bilgilendirildi.");
                appendMessageToUI(`${alert.ilac_adi} içilmedi — aile bilgilendirildi.`, "system");
                window.currentMedAlert = null;
                if (window.MedicationDefinitions) MedicationDefinitions.refresh();
                return;
            }

            if (status === "snoozed" || decision === "snoozed") {
                alert.snoozeCount = (alert.snoozeCount || 0) + 1;
                const serverCount = result?.data?.snooze_count;
                if (typeof serverCount === "number") alert.snoozeCount = serverCount;

                if (alert.snoozeCount >= MAX_SNOOZES) {
                    speakTurkish("Üç erteleme yapıldı. İlaç içilmedi olarak kaydedildi.");
                    window.currentMedAlert = null;
                    if (window.MedicationDefinitions) MedicationDefinitions.refresh();
                    return;
                }

                speakTurkish(`Tamam, ${10} dakika sonra tekrar hatırlatacağım. Kalan erteleme: ${MAX_SNOOZES - alert.snoozeCount}`);
                if (window.snoozeTimer) clearTimeout(window.snoozeTimer);
                window.snoozeTimer = setTimeout(() => {
                    if (window.currentMedAlert) showMedicationAlert(window.currentMedAlert);
                }, 10 * 60 * 1000);
            }
        } catch (e) {
            console.error("Log hatası:", e);
        }
    }

    function enhancedDismissMedicationAlert() {
        const alert = window.currentMedAlert;
        if (alert && (alert.snoozeCount || 0) >= MAX_SNOOZES) {
            speakTurkish("Daha fazla erteleme yapılamaz.");
            return;
        }
        enhancedLogMedication("snoozed", "snooze");
    }

    window.switchMedTab = function switchMedTab(tab) {
        const dailyBtn = document.getElementById("medTabDaily");
        const allBtn = document.getElementById("medTabAll");
        const dailyList = document.getElementById("medicationList");
        const allList = document.getElementById("medicationListAll");
        dailyBtn?.classList.toggle("active", tab === "daily");
        allBtn?.classList.toggle("active", tab === "all");
        if (dailyList) dailyList.hidden = tab !== "daily";
        if (allList) allList.hidden = tab !== "all";
        if (window.MedicationDefinitions?.setTodayOnly) {
            MedicationDefinitions.setTodayOnly(tab === "daily");
        }
    };

    window.logoutKiosk = function logoutKiosk() {
        localStorage.clear();
        window.location.href = "login.html";
    };

    let chatCameraStream = null;
    let pendingProfilePhotoDataUrl = null;

    async function openChatCameraModal() {
        const modal = document.getElementById("chatCameraModal");
        const video = document.getElementById("chatCameraVideo");
        const status = document.getElementById("chatCameraStatus");
        if (!modal || !video) {
            document.getElementById("chatCameraInput")?.click();
            return;
        }
        try {
            chatCameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" } },
                audio: false,
            });
            video.srcObject = chatCameraStream;
            modal.style.display = "flex";
            if (status) status.textContent = "Kameraya izin verildi. Fotoğraf çekebilirsiniz.";
        } catch (err) {
            console.error(err);
            if (status) status.textContent = "Kamera izni verilmedi, dosya seçici açılıyor.";
            document.getElementById("chatCameraInput")?.click();
        }
    }

    function closeChatCameraModal() {
        const modal = document.getElementById("chatCameraModal");
        const video = document.getElementById("chatCameraVideo");
        if (chatCameraStream) {
            chatCameraStream.getTracks().forEach((t) => t.stop());
            chatCameraStream = null;
        }
        if (video) video.srcObject = null;
        if (modal) modal.style.display = "none";
    }

    window.openChatCameraModal = openChatCameraModal;
    window.closeChatCameraModal = closeChatCameraModal;
    window.captureChatCameraPhoto = function captureChatCameraPhoto() {
        const video = document.getElementById("chatCameraVideo");
        const canvas = document.getElementById("chatCameraCanvas");
        if (!video || !canvas || !video.videoWidth) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
            if (!blob) return;
            const file = new File([blob], `camera-${Date.now()}.jpg`, { type: "image/jpeg" });
            pendingChatImage = file;
            const box = document.getElementById("chatImagePreview");
            if (box) {
                box.hidden = false;
                box.innerHTML = `
                    <img src="${URL.createObjectURL(file)}" alt="Önizleme">
                    <span>Kamera fotoğrafı hazır. İsterseniz mesaj yazıp Gönder'e basın.</span>
                    <button type="button" class="btn btn-ghost" style="width:auto;min-height:40px;" id="chatImageClearBtn">Kaldır</button>`;
                box.querySelector("#chatImageClearBtn")?.addEventListener("click", clearChatImage);
            }
            closeChatCameraModal();
        }, "image/jpeg", 0.92);
    };

    let profileCache = {
        full_name: "",
        birth_date: "",
        phone: "",
        email: "",
        conditions: "",
        allergies: "",
        height_cm: "",
        weight_kg: "",
        emergency_name: "",
        emergency_phone: "",
        notes: "",
        profile_photo_url: "",
    };

    function ageFromBirthDate(isoDate) {
        if (!isoDate) return "";
        const birth = new Date(isoDate);
        if (Number.isNaN(birth.getTime())) return "";
        const now = new Date();
        let age = now.getFullYear() - birth.getFullYear();
        const m = now.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
        return age >= 0 ? String(age) : "";
    }

    function displayOrUnknown(value) {
        const text = String(value ?? "").trim();
        return text ? text : "BİLİNMİYOR";
    }

    function formatBirthDisplay(isoDate) {
        if (!isoDate) return "";
        const d = new Date(isoDate);
        if (Number.isNaN(d.getTime())) return String(isoDate);
        return d.toLocaleDateString("tr-TR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
        });
    }

    function syncProfileFormFromCache() {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val ?? "";
        };
        set("profileName", profileCache.full_name);
        set("profileBirthDate", profileCache.birth_date);
        set("profilePhone", profileCache.phone);
        set("profileEmail", profileCache.email);
        set("profileConditions", profileCache.conditions);
        set("profileAllergies", profileCache.allergies);
        set("profileHeight", profileCache.height_cm);
        set("profileWeight", profileCache.weight_kg);
        set("profileEmergencyName", profileCache.emergency_name);
        set("profileEmergencyPhone", profileCache.emergency_phone);
        set("profileNotes", profileCache.notes);
        const preview = document.getElementById("profilePhotoPreview");
        if (preview) {
            if (profileCache.profile_photo_url) {
                preview.src = profileCache.profile_photo_url;
                preview.hidden = false;
            } else {
                preview.removeAttribute("src");
                preview.hidden = true;
            }
        }
    }

    function readProfileFormToCache() {
        profileCache = {
            full_name: document.getElementById("profileName")?.value.trim() || "",
            birth_date: document.getElementById("profileBirthDate")?.value || "",
            phone: document.getElementById("profilePhone")?.value.trim() || "",
            email: document.getElementById("profileEmail")?.value.trim() || "",
            conditions: document.getElementById("profileConditions")?.value.trim() || "",
            allergies: document.getElementById("profileAllergies")?.value.trim() || "",
            height_cm: document.getElementById("profileHeight")?.value || "",
            weight_kg: document.getElementById("profileWeight")?.value || "",
            emergency_name: document.getElementById("profileEmergencyName")?.value.trim() || "",
            emergency_phone: (document.getElementById("profileEmergencyPhone")?.value || "").replace(/\D+/g, ""),
            notes: document.getElementById("profileNotes")?.value.trim() || "",
            profile_photo_url: pendingProfilePhotoDataUrl || profileCache.profile_photo_url || "",
        };
    }

    function profileField(icon, value, options = {}) {
        const { wide = false, tall = false, label = "" } = options;
        const shown = displayOrUnknown(value);
        const empty = shown === "BİLİNMİYOR";
        return `
            <div class="profile-field${wide ? " is-wide" : ""}${tall ? " is-tall" : ""}">
                <div class="profile-field-meta">
                    <span class="profile-field-icon" aria-hidden="true">${icon}</span>
                    <span class="profile-field-label">${label}</span>
                </div>
                <div class="profile-field-box${empty ? " is-empty" : ""}${tall ? " is-tall" : ""}">
                    ${empty ? "BİLİNMİYOR" : shown}
                </div>
            </div>`;
    }

    function renderProfileView() {
        const view = document.getElementById("profileView");
        if (!view) return;

        const name = profileCache.full_name || localStorage.getItem("user_name") || "";
        const birth = profileCache.birth_date || "";
        const age = ageFromBirthDate(birth);
        const photo = pendingProfilePhotoDataUrl || profileCache.profile_photo_url || "";

        view.innerHTML = `
            <button type="button" class="profile-pencil-btn" onclick="startProfileEdit()" title="Düzenle" aria-label="Profili düzenle">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
            </button>
            <div class="profile-layout">
                <div class="profile-col profile-col-left">
                    <div class="profile-photo-block">
                        ${
                            photo
                                ? `<img class="profile-photo" src="${photo}" alt="Profil">`
                                : `<div class="profile-photo-placeholder">👤</div>`
                        }
                        <button type="button" class="profile-photo-plus" onclick="pickProfilePhoto()" title="Fotoğraf ekle">+</button>
                        <input type="file" id="profilePhotoQuickInput" accept="image/*" hidden>
                    </div>
                    ${profileField("👤", name, { label: "Ad soyad" })}
                    ${profileField("🎂", age, { label: "Yaş" })}
                    ${profileField("📅", formatBirthDisplay(birth), { label: "Doğum tarihi" })}
                    ${profileField("📞", profileCache.phone, { label: "Telefon" })}
                    ${profileField("✉️", profileCache.email, { label: "E-posta" })}
                </div>
                <div class="profile-col profile-col-right">
                    ${profileField("🏥", profileCache.conditions, { wide: true, label: "Kronik / teşhisli hastalıklar" })}
                    ${profileField("⚠️", profileCache.allergies, { wide: true, label: "Alerjiler" })}
                    <div class="profile-field-row">
                        ${profileField("🧍", profileCache.weight_kg ? `${profileCache.weight_kg} kg` : "", { label: "Kilo" })}
                        ${profileField("📏", profileCache.height_cm ? `${profileCache.height_cm} cm` : "", { label: "Boy" })}
                    </div>
                    ${profileField("🚨", profileCache.emergency_name, { wide: true, label: "Acil durum kişisi" })}
                    ${profileField("☎️", profileCache.emergency_phone, { wide: true, label: "Acil durum telefonu" })}
                    ${profileField("📋", profileCache.notes, { wide: true, tall: true, label: "Ek notlar" })}
                </div>
            </div>
        `;

        const quick = document.getElementById("profilePhotoQuickInput");
        if (quick && !quick.dataset.bound) {
            quick.dataset.bound = "1";
            quick.addEventListener("change", async () => {
                const file = quick.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async () => {
                    pendingProfilePhotoDataUrl = String(reader.result || "");
                    profileCache.profile_photo_url = pendingProfilePhotoDataUrl;
                    renderProfileView();
                    await saveProfilePhotoOnly();
                };
                reader.readAsDataURL(file);
            });
        }
    }

    window.pickProfilePhoto = function pickProfilePhoto() {
        const input = document.getElementById("profilePhotoQuickInput");
        if (input) input.click();
    };

    async function saveProfilePhotoOnly() {
        const userId = localStorage.getItem("user_id");
        if (!userId || !profileCache.profile_photo_url) return;
        try {
            await fetch(`${apiBase()}/elder-profile/${userId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    full_name: profileCache.full_name || null,
                    birth_date: profileCache.birth_date || null,
                    phone: profileCache.phone || "",
                    email: profileCache.email || "",
                    conditions: profileCache.conditions || "",
                    allergies: profileCache.allergies || "",
                    height_cm: profileCache.height_cm || null,
                    weight_kg: profileCache.weight_kg || null,
                    emergency_name: profileCache.emergency_name || "",
                    emergency_phone: profileCache.emergency_phone || "",
                    notes: profileCache.notes || "",
                    profile_photo_url: profileCache.profile_photo_url,
                }),
            });
        } catch (_) { /* ignore */ }
    }

    window.startProfileEdit = function startProfileEdit() {
        syncProfileFormFromCache();
        const modal = document.getElementById("profileEditModal");
        if (modal) modal.classList.add("active");
        const status = document.getElementById("profileStatus");
        if (status) {
            status.textContent = "";
            status.className = "login-status";
        }
        const photoInput = document.getElementById("profilePhotoInput");
        if (photoInput && !photoInput.dataset.bound) {
            photoInput.dataset.bound = "1";
            photoInput.addEventListener("change", () => {
                const file = photoInput.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    pendingProfilePhotoDataUrl = String(reader.result || "");
                    profileCache.profile_photo_url = pendingProfilePhotoDataUrl;
                    const preview = document.getElementById("profilePhotoPreview");
                    if (preview) {
                        preview.src = pendingProfilePhotoDataUrl;
                        preview.hidden = false;
                    }
                };
                reader.readAsDataURL(file);
            });
        }
    };

    window.cancelProfileEdit = function cancelProfileEdit() {
        const modal = document.getElementById("profileEditModal");
        if (modal) modal.classList.remove("active");
        syncProfileFormFromCache();
        renderProfileView();
    };

    function profileSetupDoneKey(userId) {
        return `profile_setup_done_${userId || "anon"}`;
    }

    function markProfileSetupDone(userId) {
        localStorage.setItem(profileSetupDoneKey(userId), "1");
        localStorage.removeItem("needs_profile_setup");
    }

    function isProfileSetupDone(userId) {
        return localStorage.getItem(profileSetupDoneKey(userId)) === "1";
    }

    function fillProfileSetupForm() {
        const set = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val ?? "";
        };
        set("setupPhone", profileCache.phone);
        set("setupEmail", profileCache.email);
        set("setupWeight", profileCache.weight_kg);
        set("setupHeight", profileCache.height_cm);
        set("setupConditions", profileCache.conditions);
        set("setupAllergies", profileCache.allergies);
        set("setupEmergencyName", profileCache.emergency_name);
        set("setupEmergencyPhone", profileCache.emergency_phone);
        set("setupNotes", profileCache.notes);
        const preview = document.getElementById("setupPhotoPreview");
        if (preview) {
            if (profileCache.profile_photo_url) {
                preview.src = profileCache.profile_photo_url;
                preview.hidden = false;
            } else {
                preview.removeAttribute("src");
                preview.hidden = true;
            }
        }
        const photoInput = document.getElementById("setupPhotoInput");
        if (photoInput && !photoInput.dataset.bound) {
            photoInput.dataset.bound = "1";
            photoInput.addEventListener("change", () => {
                const file = photoInput.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    pendingProfilePhotoDataUrl = String(reader.result || "");
                    profileCache.profile_photo_url = pendingProfilePhotoDataUrl;
                    if (preview) {
                        preview.src = pendingProfilePhotoDataUrl;
                        preview.hidden = false;
                    }
                };
                reader.readAsDataURL(file);
            });
        }
    }

    function openProfileSetupModal() {
        fillProfileSetupForm();
        const modal = document.getElementById("profileSetupModal");
        if (modal) modal.classList.add("active");
        const status = document.getElementById("profileSetupStatus");
        if (status) {
            status.textContent = "";
            status.className = "login-status";
        }
    }

    function closeProfileSetupModal() {
        const modal = document.getElementById("profileSetupModal");
        if (modal) modal.classList.remove("active");
    }

    window.skipProfileSetup = function skipProfileSetup() {
        const userId = localStorage.getItem("user_id");
        markProfileSetupDone(userId);
        closeProfileSetupModal();
    };

    window.saveProfileSetup = async function saveProfileSetup() {
        const userId = localStorage.getItem("user_id");
        const status = document.getElementById("profileSetupStatus");
        if (!userId) {
            if (status) {
                status.textContent = "Oturum bulunamadı.";
                status.className = "login-status is-error";
            }
            return;
        }

        profileCache = {
            ...profileCache,
            phone: document.getElementById("setupPhone")?.value.trim() || "",
            email: document.getElementById("setupEmail")?.value.trim() || "",
            weight_kg: document.getElementById("setupWeight")?.value || "",
            height_cm: document.getElementById("setupHeight")?.value || "",
            conditions: document.getElementById("setupConditions")?.value.trim() || "",
            allergies: document.getElementById("setupAllergies")?.value.trim() || "",
            emergency_name: document.getElementById("setupEmergencyName")?.value.trim() || "",
            emergency_phone: (document.getElementById("setupEmergencyPhone")?.value || "").replace(/\D+/g, ""),
            notes: document.getElementById("setupNotes")?.value.trim() || "",
            profile_photo_url: pendingProfilePhotoDataUrl || profileCache.profile_photo_url || "",
        };

        const payload = {
            full_name: profileCache.full_name || localStorage.getItem("user_name") || null,
            birth_date: profileCache.birth_date || null,
            phone: profileCache.phone,
            email: profileCache.email,
            conditions: profileCache.conditions,
            allergies: profileCache.allergies,
            height_cm: profileCache.height_cm || null,
            weight_kg: profileCache.weight_kg || null,
            emergency_name: profileCache.emergency_name,
            emergency_phone: profileCache.emergency_phone,
            notes: profileCache.notes,
            profile_photo_url: profileCache.profile_photo_url || null,
        };

        try {
            const res = await fetch(`${apiBase()}/elder-profile/${userId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || "Kaydedilemedi");
            markProfileSetupDone(userId);
            closeProfileSetupModal();
            await loadElderProfile({ skipSetupPrompt: true });
            speakTurkish("Profil bilgileriniz kaydedildi.");
        } catch (err) {
            if (status) {
                status.textContent = err.message || "Hata";
                status.className = "login-status is-error";
            }
        }
    };

    async function maybeShowProfileSetup() {
        if (localStorage.getItem("kiosk_demo_mode")) return;
        if (localStorage.getItem("user_role") === "family") return;
        const userId = localStorage.getItem("user_id");
        if (!userId) return;
        // Sadece kayıt sonrası işaretlenen ilk girişte göster
        if (localStorage.getItem("needs_profile_setup") !== "1") return;
        if (isProfileSetupDone(userId)) {
            localStorage.removeItem("needs_profile_setup");
            return;
        }
        openProfileSetupModal();
    }

    async function loadElderProfile(options = {}) {
        const userId = localStorage.getItem("user_id");
        const label = document.getElementById("appUserLabel");
        const display = localStorage.getItem("user_name") || "";
        if (label) label.textContent = display ? `Merhaba, ${display}` : "Hoş geldiniz";

        if (display) profileCache.full_name = profileCache.full_name || display;

        if (userId) {
            try {
                const res = await fetch(`${apiBase()}/elder-profile/${userId}`);
                if (res.ok) {
                    const data = await res.json();
                    const p = data.profile || data || {};
                    profileCache = {
                        full_name: p.full_name || p.name || display || "",
                        birth_date: p.birth_date || "",
                        phone: p.phone || "",
                        email: p.email || "",
                        conditions: p.conditions || "",
                        allergies: p.allergies || "",
                        height_cm: p.height_cm != null ? String(p.height_cm) : "",
                        weight_kg: p.weight_kg != null ? String(p.weight_kg) : "",
                        emergency_name: p.emergency_name || "",
                        emergency_phone: p.emergency_phone || "",
                        notes: p.notes || "",
                        profile_photo_url: p.profile_photo_url || "",
                    };
                    if (profileCache.profile_photo_url) {
                        pendingProfilePhotoDataUrl = profileCache.profile_photo_url;
                    }
                    if (profileCache.full_name) {
                        localStorage.setItem("user_name", profileCache.full_name);
                        if (label) label.textContent = `Merhaba, ${profileCache.full_name}`;
                    }
                }
            } catch (_) { /* ignore */ }
        }
        syncProfileFormFromCache();
        renderProfileView();
        if (!options.skipSetupPrompt) {
            await maybeShowProfileSetup();
        }
    }

    window.saveElderProfile = async function saveElderProfile() {
        const userId = localStorage.getItem("user_id");
        const status = document.getElementById("profileStatus");
        if (!userId) {
            if (status) {
                status.textContent = "Oturum bulunamadı.";
                status.className = "login-status is-error";
            }
            return;
        }
        readProfileFormToCache();
        if (profileCache.full_name) localStorage.setItem("user_name", profileCache.full_name);
        const payload = {
            full_name: profileCache.full_name,
            birth_date: profileCache.birth_date || null,
            phone: profileCache.phone,
            email: profileCache.email,
            conditions: profileCache.conditions,
            allergies: profileCache.allergies,
            height_cm: profileCache.height_cm || null,
            weight_kg: profileCache.weight_kg || null,
            emergency_name: profileCache.emergency_name,
            emergency_phone: profileCache.emergency_phone,
            notes: profileCache.notes,
            profile_photo_url: profileCache.profile_photo_url || null,
        };
        try {
            const res = await fetch(`${apiBase()}/elder-profile/${userId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.detail || "Kaydedilemedi");
            if (status) {
                status.textContent = "Profil kaydedildi.";
                status.className = "login-status is-ok";
            }
            speakTurkish("Profiliniz kaydedildi.");
            const label = document.getElementById("appUserLabel");
            if (label && profileCache.full_name) {
                label.textContent = `Merhaba, ${profileCache.full_name}`;
            }
            const modal = document.getElementById("profileEditModal");
            if (modal) modal.classList.remove("active");
            await loadElderProfile();
        } catch (err) {
            if (status) {
                status.textContent = err.message || "Hata";
                status.className = "login-status is-error";
            }
        }
    };

    window.sendComposer = async function sendComposer() {
        if (pendingChatImage) {
            await sendChatImage();
            return;
        }
        if (typeof sendTextMessage === "function") {
            await sendTextMessage();
        }
    };

    async function sendChatImage() {
        if (!pendingChatImage) return;
        const caption = document.getElementById("userInput")?.value.trim() || "";
        const previewUrl = URL.createObjectURL(pendingChatImage);
        appendMessageToUI(caption || "📷 Fotoğraf gönderildi", "user", { imageUrl: previewUrl });

        const formData = new FormData();
        formData.append("file", pendingChatImage);
        formData.append("message", caption || "Bu görseli incele ve Türkçe yanıt ver.");
        formData.append("conversation_id", window.activeChatId);
        if (window.realUserId) formData.append("user_id", window.realUserId);
        formData.append("user_name", window.userDisplayName || "");
        const elderId = typeof getOwnerElderId === "function" ? getOwnerElderId() : null;
        if (elderId) formData.append("elder_id", elderId);

        clearChatImage();
        const input = document.getElementById("userInput");
        if (input) input.value = "";

        try {
            const res = await fetch(`${apiBase()}/chat-image`, {
                method: "POST",
                body: formData,
            });
            const data = await res.json();
            appendMessageToUI(data.ai_response || "Resminizi inceledim.", "ai");
            if (typeof loadConversationsFromSupabase === "function") {
                await loadConversationsFromSupabase();
            }
        } catch (err) {
            console.error(err);
            appendMessageToUI("Resim gönderilemedi.", "ai");
        }
    }

    function clearChatImage() {
        pendingChatImage = null;
        const box = document.getElementById("chatImagePreview");
        if (box) {
            box.hidden = true;
            box.innerHTML = "";
        }
        const gallery = document.getElementById("chatImageInput");
        if (gallery) gallery.value = "";
        const cam = document.getElementById("chatCameraInput");
        if (cam) cam.value = "";
    }

    function bindImageInput(input) {
        if (!input || input.dataset.bound) return;
        input.dataset.bound = "1";
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return;
            pendingChatImage = file;
            const box = document.getElementById("chatImagePreview");
            if (box) {
                box.hidden = false;
                box.innerHTML = `
                    <img src="${URL.createObjectURL(file)}" alt="Önizleme">
                    <span>Görsel hazır. İsterseniz mesaj yazıp Gönder'e basın.</span>
                    <button type="button" class="btn btn-ghost" style="width:auto;min-height:40px;" id="chatImageClearBtn">Kaldır</button>`;
                box.querySelector("#chatImageClearBtn")?.addEventListener("click", clearChatImage);
            }
        });
    }

    function setAttachMenuOpen(isOpen) {
        const menu = document.getElementById("chatAttachMenu");
        const btn = document.getElementById("chatAttachBtn");
        if (!menu || !btn) return;
        menu.hidden = !isOpen;
        btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }

    function wireChatImage() {
        bindImageInput(document.getElementById("chatImageInput"));
        bindImageInput(document.getElementById("chatCameraInput"));

        const attachBtn = document.getElementById("chatAttachBtn");
        const menu = document.getElementById("chatAttachMenu");
        const galleryBtn = document.getElementById("chatAttachGalleryBtn");
        const cameraBtn = document.getElementById("chatAttachCameraBtn");
        const galleryInput = document.getElementById("chatImageInput");
        const cameraInput = document.getElementById("chatCameraInput");

        if (attachBtn && !attachBtn.dataset.bound) {
            attachBtn.dataset.bound = "1";
            attachBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                setAttachMenuOpen(menu?.hidden !== false);
            });
        }
        if (galleryBtn && !galleryBtn.dataset.bound) {
            galleryBtn.dataset.bound = "1";
            galleryBtn.addEventListener("click", () => {
                setAttachMenuOpen(false);
                galleryInput?.click();
            });
        }
        if (cameraBtn && !cameraBtn.dataset.bound) {
            cameraBtn.dataset.bound = "1";
            cameraBtn.addEventListener("click", () => {
                setAttachMenuOpen(false);
                openChatCameraModal();
            });
        }
        if (!document.body.dataset.attachMenuBound) {
            document.body.dataset.attachMenuBound = "1";
            document.addEventListener("click", (event) => {
                const group = document.querySelector(".chat-attach-group");
                if (!group || group.contains(event.target)) return;
                setAttachMenuOpen(false);
            });
        }
    }

    function enhancedSwitchPage(pageId) {
        if (baseSwitchPage) baseSwitchPage(pageId);
        document.querySelectorAll(".app-tab").forEach((btn) => btn.classList.remove("active"));
        const map = {
            sohbet: "nav-sohbet",
            ilaclar: "nav-ilaclar",
            durum: "nav-durum",
            profil: "nav-profil",
        };
        document.getElementById(map[pageId])?.classList.add("active");

        // Eski nav id'leri
        document.getElementById(`nav-${pageId}`)?.classList.add("active");

        if (pageId === "profil") loadElderProfile();
        if (pageId === "ilaclar" && window.MedicationDefinitions) {
            MedicationDefinitions.refresh();
        }
        logActivity("page_view", { page: pageId });
    }

    function logActivity(eventType, meta) {
        const userId =
            localStorage.getItem("user_id") ||
            localStorage.getItem("elder_profile_id_fallback");
        const elderId = localStorage.getItem("elder_id");
        if (!userId && !elderId) return;
        fetch(`${apiBase()}/activity`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                event_type: eventType,
                user_id: userId || null,
                elder_id: elderId || null,
                meta: meta || {},
            }),
        }).catch(() => {});
    }

    function startActivityHeartbeat() {
        logActivity("heartbeat", { reason: "boot" });
        setInterval(() => {
            if (document.visibilityState === "visible") {
                logActivity("heartbeat", { reason: "interval" });
            }
        }, 5 * 60 * 1000);
    }

    window.toggleSideNav = function toggleSideNav(forceOpen) {
        const rail = document.getElementById("sideNavRail");
        const nav = document.getElementById("appSideNav");
        const btn = document.getElementById("navToggleBtn");
        const target = rail || nav;
        if (!target) return;
        const isCollapsed = target.classList.contains("is-collapsed");
        const willExpand =
            typeof forceOpen === "boolean" ? forceOpen : isCollapsed;
        target.classList.toggle("is-collapsed", !willExpand);
        if (nav && rail) nav.classList.toggle("is-collapsed", !willExpand);
        if (btn) {
            btn.setAttribute("aria-expanded", willExpand ? "true" : "false");
            btn.title = willExpand ? "Menüyü daralt" : "Menüyü genişlet";
        }
    };

    function patchGlobals() {
        baseSwitchPage = window.switchPage;

        window.appendMessageToUI = function (text, sender, options) {
            enhancedAppendMessage(text, sender, options || {});
        };
        window.toggleVoice = enhancedToggleVoice;
        window.completeCheckin = enhancedCompleteCheckin;
        window.dismissMedicationAlert = enhancedDismissMedicationAlert;
        window.showMedicationAlert = enhancedShowMedicationAlert;
        window.logMedication = enhancedLogMedication;
        window.switchPage = enhancedSwitchPage;
    }

    function boot() {
        patchGlobals();
        wireChatImage();
        loadElderProfile();
        startActivityHeartbeat();
        const greet = document.getElementById("checkinGreeting");
        if (greet && window.userDisplayName) {
            greet.textContent = `${window.userDisplayName}, bugün kendini nasıl hissediyorsun?`;
        }
        // İlk AI mesajını sesli okuma + check-in hatırlatması
        const firstAi = document.querySelector("#chatBox .msg-ai");
        if (firstAi && !sessionStorage.getItem("kiosk_greeted")) {
            sessionStorage.setItem("kiosk_greeted", "1");
            setTimeout(() => speakTurkish(firstAi.textContent), 600);
        }
        // Check-in pop-up açıksa sesli hatırlat
        setTimeout(() => {
            const modal = document.getElementById("checkinReminderModal");
            if (modal && modal.style.display === "flex" && !sessionStorage.getItem("kiosk_checkin_spoken")) {
                sessionStorage.setItem("kiosk_checkin_spoken", "1");
                speakTurkish("Günlük sağlık kontrolü zamanı. Bugün nasıl hissediyorsunuz?");
            }
        }, 1400);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();

