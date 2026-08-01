/**
 * İlaç tanımlama modülü — medications + medication_schedules CRUD
 * Kullanım: MedicationDefinitions.init({ mode: "kiosk" | "family" })
 */
window.MedicationDefinitions = (() => {
    const DAY_LABELS = [
        { value: 1, label: "Pzt" },
        { value: 2, label: "Sal" },
        { value: 3, label: "Çar" },
        { value: 4, label: "Per" },
        { value: 5, label: "Cum" },
        { value: 6, label: "Cmt" },
        { value: 7, label: "Paz" },
    ];

    const state = {
        apiBaseUrl: (window.CONFIG && CONFIG.API_BASE_URL) || "http://127.0.0.1:8000/api",
        elderId: null,
        userId: null,
        userName: "",
        mode: "kiosk",
        todayOnly: true,
        medications: [],
    };

    function getEls(mode) {
        if (mode === "family") {
            return {
                formRoot: document.getElementById("familyMedFormRoot"),
                listRoot: document.getElementById("familyMedListRoot"),
                toolbar: null,
            };
        }
        const dailyHidden = document.getElementById("medicationList")?.hidden;
        return {
            formRoot: document.getElementById("medAddFormRoot"),
            listRoot: dailyHidden
                ? document.getElementById("medicationListAll")
                : document.getElementById("medicationList"),
            listDaily: document.getElementById("medicationList"),
            listAll: document.getElementById("medicationListAll"),
            toolbar: document.getElementById("medicationToolbar"),
        };
    }

    function formatTimeLabel(timeValue) {
        const hour = parseInt(String(timeValue).slice(0, 2), 10);
        const part = hour < 12 ? "Sabah" : "Akşam";
        return `${part} • ${String(timeValue).slice(0, 5)}`;
    }

    function formatDays(days) {
        if (!days || days.length === 7) return "Her gün";
        return days
            .map((day) => DAY_LABELS.find((item) => item.value === day)?.label || day)
            .join(", ");
    }

    function readSelectedDays(formRoot) {
        return Array.from(formRoot.querySelectorAll(".med-def-day input:checked")).map((input) =>
            parseInt(input.value, 10)
        );
    }

    const FOOD_LABELS = {
        aç: "Aç karnına",
        tok: "Tok karnına",
        farketmez: "Aç/tok fark etmez",
    };

    function packNotes(purpose, foodTiming) {
        const p = (purpose || "").trim();
        const f = (foodTiming || "farketmez").trim();
        return `${p}|||${f}`;
    }

    function unpackNotes(notes) {
        const raw = String(notes || "");
        if (raw.includes("|||")) {
            const [purpose, food] = raw.split("|||");
            return {
                purpose: (purpose || "").trim(),
                foodTiming: (food || "farketmez").trim() || "farketmez",
            };
        }
        return { purpose: raw.trim(), foodTiming: "farketmez" };
    }

    function foodTimingLabel(value) {
        return FOOD_LABELS[value] || FOOD_LABELS.farketmez;
    }

    function renderForm(formRoot, options = {}) {
        if (!formRoot) return;
        const editing = options.medication || null;
        const formTitle = editing ? "✏️ İlacı Düzenle" : state.mode === "kiosk" ? "➕ Yeni İlaç Ekle" : "➕ Yeni İlaç Tanımla";
        const showCancel = true;
        const unpacked = unpackNotes(editing?.notes);
        const foodTiming = editing?.food_timing || unpacked.foodTiming;
        const existingTimes = (editing?.medication_schedules || []).map((s) =>
            String(s.time_of_day).slice(0, 5)
        );
        const timesHtml =
            existingTimes.length > 0
                ? existingTimes.map((t) => `<input type="time" class="medDefTimeInput" value="${t}" />`).join("")
                : `<input type="time" class="medDefTimeInput" value="09:00" />`;

        formRoot.innerHTML = `
            <div class="med-def-panel">
                <h3>${formTitle}</h3>
                <input type="hidden" id="medDefEditId" value="${editing?.id || ""}" />
                <div class="med-def-grid">
                    <input type="text" id="medDefName" placeholder="İlaç adı" value="${editing?.name || ""}" />
                    <input type="text" id="medDefPurpose" placeholder="Ne için? (ör. tansiyon)" value="${unpacked.purpose || ""}" />
                    <input type="text" id="medDefDosage" placeholder="Her seferde doz (ör. 1 tablet)" value="${editing?.dosage || ""}" />
                    <select id="medDefForm">
                        <option value="tablet">Tablet</option>
                        <option value="kapsül">Kapsül</option>
                        <option value="şurup">Şurup</option>
                        <option value="damla">Damla</option>
                        <option value="iğne">İğne / Enjeksiyon</option>
                        <option value="krem">Krem / Merhem</option>
                        <option value="sprey">Sprey</option>
                        <option value="toz">Toz</option>
                        <option value="flaster">Flaster</option>
                    </select>
                    <label style="grid-column:1/-1;font-weight:700;">Aç / tok durumu
                        <select id="medDefFoodTiming">
                            <option value="farketmez">Fark etmez</option>
                            <option value="aç">Aç karnına</option>
                            <option value="tok">Tok karnına</option>
                        </select>
                    </label>
                    <label style="grid-column:1/-1;font-weight:700;">Günde kaç kez?
                        <select id="medDefTimesPerDay">
                            <option value="1">1</option>
                            <option value="2">2</option>
                            <option value="3">3</option>
                            <option value="4">4</option>
                        </select>
                    </label>
                    <div id="medDefTimesWrap" style="grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;">
                        ${timesHtml}
                    </div>
                </div>
                <p style="font-size:16px; color:#64748B; margin-bottom:8px;">Hangi günler?</p>
                <div class="med-def-days">
                    ${DAY_LABELS.map((day) => {
                        const checked =
                            !editing ||
                            (editing.medication_schedules?.[0]?.days_of_week || [1,2,3,4,5,6,7]).includes(day.value);
                        return `
                        <label class="med-def-day">
                            <input type="checkbox" value="${day.value}" ${checked ? "checked" : ""} />
                            ${day.label}
                        </label>`;
                    }).join("")}
                </div>
                <div class="med-def-actions">
                    <button type="button" class="btn btn-success" id="medDefSaveBtn">${editing ? "Güncelle" : "İlacı Kaydet"}</button>
                    ${showCancel ? '<button type="button" class="btn btn-neutral" id="medDefCancelBtn">İptal</button>' : ""}
                </div>
            </div>
        `;

        if (editing?.form) {
            const sel = formRoot.querySelector("#medDefForm");
            if (sel) sel.value = editing.form;
        }
        const foodSel = formRoot.querySelector("#medDefFoodTiming");
        if (foodSel) foodSel.value = foodTiming || "farketmez";

        const syncTimeInputs = () => {
            const n = parseInt(formRoot.querySelector("#medDefTimesPerDay")?.value || "1", 10);
            const wrap = formRoot.querySelector("#medDefTimesWrap");
            if (!wrap) return;
            const current = Array.from(wrap.querySelectorAll(".medDefTimeInput")).map((el) => el.value);
            wrap.innerHTML = "";
            const defaults = ["09:00", "14:00", "20:00", "22:00"];
            for (let i = 0; i < n; i += 1) {
                const input = document.createElement("input");
                input.type = "time";
                input.className = "medDefTimeInput";
                input.value = current[i] || defaults[i] || "09:00";
                wrap.appendChild(input);
            }
        };
        formRoot.querySelector("#medDefTimesPerDay")?.addEventListener("change", syncTimeInputs);
        if (existingTimes.length) {
            formRoot.querySelector("#medDefTimesPerDay").value = String(Math.min(4, existingTimes.length));
        }

        formRoot.querySelector("#medDefSaveBtn").addEventListener("click", () => saveMedication(formRoot));
        formRoot.querySelector("#medDefCancelBtn")?.addEventListener("click", closeAddModal);
        formRoot.dataset.rendered = "true";
    }

    function openEditModal(medicationId) {
        const med = state.medications.find((m) => m.id === medicationId);
        if (!med) return;

        if (state.mode === "family") {
            const formRoot = document.getElementById("familyMedFormRoot");
            if (!formRoot) return;
            formRoot.dataset.rendered = "false";
            renderForm(formRoot, { medication: med });
            formRoot.scrollIntoView({ behavior: "smooth", block: "nearest" });
            return;
        }

        const modal = document.getElementById("medAddModal");
        const formRoot = document.getElementById("medAddFormRoot");
        if (!formRoot) return;
        formRoot.dataset.rendered = "false";
        renderForm(formRoot, { medication: med });
        if (modal) modal.classList.add("active");
    }

    function renderKioskToolbar(toolbar) {
        if (!toolbar) return;
        toolbar.innerHTML = `
            <button type="button" class="btn btn-success" style="width:100%; font-size:18px; padding:14px; margin-bottom:16px;"
                onclick="MedicationDefinitions.openAddModal()">
                ➕ İlaç Ekle
            </button>
        `;
    }

    function renderFamilyAddButton(formRoot) {
        if (!formRoot) return;
        formRoot.innerHTML = `
            <div class="med-def-add-wrap">
                <button type="button" class="btn btn-success med-def-add-btn" onclick="MedicationDefinitions.openAddModal()">
                    <i class="fas fa-plus" aria-hidden="true"></i> Yeni İlaç Ekle
                </button>
            </div>
        `;
        formRoot.dataset.rendered = "false";
    }

    function openAddModal() {
        if (state.mode === "family") {
            const formRoot = document.getElementById("familyMedFormRoot");
            if (!formRoot) return;
            formRoot.dataset.rendered = "false";
            renderForm(formRoot, { force: true });
            formRoot.scrollIntoView({ behavior: "smooth", block: "nearest" });
            return;
        }

        const modal = document.getElementById("medAddModal");
        const formRoot = document.getElementById("medAddFormRoot");
        if (formRoot) {
            formRoot.dataset.rendered = "false";
            renderForm(formRoot, { force: true });
        }
        if (modal) {
            modal.classList.add("active");
        }
    }

    function closeAddModal() {
        if (state.mode === "family") {
            const formRoot = document.getElementById("familyMedFormRoot");
            renderFamilyAddButton(formRoot);
            return;
        }
        const modal = document.getElementById("medAddModal");
        if (modal) {
            modal.classList.remove("active");
        }
    }

    async function toggleActive(medicationId, isActive) {
        try {
            const response = await fetch(`${state.apiBaseUrl}/medications/${medicationId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ is_active: isActive }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.detail || "Güncellenemedi");
            await refresh();
        } catch (error) {
            alert(error.message || "Aktiflik güncellenemedi");
        }
    }

    async function syncElder() {
        const response = await fetch(`${state.apiBaseUrl}/medications/sync-elder`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: state.userId,
                user_name: state.userName,
            }),
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.detail || "Yaşlı profili eşleştirilemedi.");
        }

        state.elderId = data.elder.id;
        localStorage.setItem("elder_id", state.elderId);
        if (state.userId) {
            localStorage.setItem("elder_bound_user_id", state.userId);
        }
        return data.elder;
    }

    function isStoredElderBoundToCurrentUser() {
        const storedElderId = localStorage.getItem("elder_id");
        const boundUserId = localStorage.getItem("elder_bound_user_id");
        if (!storedElderId || !state.userId) return false;
        // Demo fallback kimliği farklı olabilir; gerçek login user_id ile bağ olmalı
        return boundUserId === state.userId;
    }

    async function ensureElder() {
        if (state.elderId && isStoredElderBoundToCurrentUser() && state.elderId === localStorage.getItem("elder_id")) {
            return state.elderId;
        }

        if (isStoredElderBoundToCurrentUser()) {
            state.elderId = localStorage.getItem("elder_id");
            return state.elderId;
        }

        // Eski oturumdan kalan elder_id'yi kullanma — kullanıcıya özel sync yap
        localStorage.removeItem("elder_id");
        state.elderId = null;
        await syncElder();
        return state.elderId;
    }

    async function loadMedications() {
        await ensureElder();
        const query = state.todayOnly ? "?today_only=true" : "";
        const response = await fetch(`${state.apiBaseUrl}/medications/elder/${state.elderId}${query}`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "İlaç listesi alınamadı.");
        }

        state.medications = data.medications || [];
        return state.medications;
    }

    function emptyListMessage() {
        if (state.mode === "family") {
            return "Henüz tanımlı ilaç yok. Yeni İlaç Ekle butonu ile ekleyebilirsiniz.";
        }
        if (state.todayOnly) {
            return "Bugün için planlanmış ilaç yok. İlaç Ekle ile yeni ilaç ekleyebilirsiniz.";
        }
        return "İlaç yok. Henüz hiç ilaç eklenmemiş; İlaç Ekle ile tanımlayabilirsiniz.";
    }

    function renderList(listRoot) {
        if (!listRoot) return;

        if (state.medications.length === 0) {
            listRoot.innerHTML = `<p class="med-def-empty">${emptyListMessage()}</p>`;
            return;
        }

        listRoot.innerHTML = state.medications
            .map((med) => {
                const schedules = med.medication_schedules || [];
                const unpacked = unpackNotes(med.notes);
                const foodTiming = med.food_timing || unpacked.foodTiming;
                const foodLabel = foodTimingLabel(foodTiming);
                const purpose = unpacked.purpose;
                const isActive = med.is_active !== false;
                const safeName = med.name.replace(/'/g, "\\'");

                const scheduleHtml = schedules.length
                    ? schedules
                          .map((schedule) => {
                              const status = schedule.today_status;
                              const timeLabel = formatTimeLabel(schedule.time_of_day);
                              let statusHtml = "";
                              if (state.mode === "kiosk") {
                                  if (status === "taken") {
                                      statusHtml = `<div class="med-def-done-chip">✓ Alındı</div>`;
                                  } else if (status === "snoozed") {
                                      statusHtml = `<div class="med-def-snooze-chip">⏳ Ertelendi</div>`;
                                  } else if (status === "missed") {
                                      statusHtml = `<div class="med-def-missed-chip">Kaçırıldı</div>`;
                                  } else if (status === "wrong_medication") {
                                      statusHtml = `<div class="med-def-missed-chip">Yanlış ilaç</div>`;
                                  } else {
                                      statusHtml = `
                                        <div class="med-def-verify-actions">
                                            <button type="button" class="btn btn-success med-mini-btn"
                                                onclick="MedicationDefinitions.markTaken('${med.id}', '${schedule.id}', '${safeName}')">İçtim</button>
                                            <button type="button" class="btn btn-neutral med-mini-btn"
                                                onclick="MedicationRecognition.open('${med.id}', '${safeName}', '${schedule.id}')">Doğrula</button>
                                        </div>`;
                                  }
                              } else if (state.mode === "family") {
                                  statusHtml = `<button type="button" class="med-def-danger" onclick="MedicationDefinitions.removeSchedule('${schedule.id}')">Saati Sil</button>`;
                              }

                              return `
                                <div class="med-def-schedule-item">
                                    <div class="med-def-schedule-left">
                                        <strong>${timeLabel}</strong>
                                        <span>${formatDays(schedule.days_of_week)}</span>
                                        <em>${foodLabel}</em>
                                    </div>
                                    <div class="med-def-schedule-right">${statusHtml}</div>
                                </div>`;
                          })
                          .join("")
                    : '<p class="med-def-empty">Saat tanımlı değil.</p>';

                const allTaken =
                    schedules.length > 0 &&
                    schedules.every((schedule) => schedule.today_status === "taken");

                const familyActions =
                    state.mode === "family"
                        ? `<div class="med-def-head-actions">
                            <button type="button" class="btn btn-ghost med-edit-btn"
                                onclick="MedicationDefinitions.openEditModal('${med.id}')">Düzenle</button>
                            <button type="button" class="med-def-danger" onclick="MedicationDefinitions.deactivateMedication('${med.id}')">Pasifleştir</button>
                           </div>`
                        : "";

                const headActions =
                    state.mode === "kiosk"
                        ? `
                        <div class="med-def-head-actions">
                            <label class="med-switch" title="Aktif / Pasif">
                                <input type="checkbox" ${isActive ? "checked" : ""}
                                    onchange="MedicationDefinitions.toggleActive('${med.id}', this.checked)" />
                                <span class="med-switch-track" aria-hidden="true">
                                    <i class="on">ON</i>
                                    <i class="off">OFF</i>
                                </span>
                            </label>
                            <button type="button" class="btn btn-ghost med-edit-btn"
                                onclick="MedicationDefinitions.openEditModal('${med.id}')">Düzenle</button>
                        </div>`
                        : familyActions;

                return `
                    <div class="med-def-card${allTaken ? " med-def-card-done" : ""}${!isActive ? " med-def-card-inactive" : ""}" id="med-card-${med.id}" data-med-name="${med.name}" data-food-timing="${foodTiming}">
                        <div class="med-def-card-head">
                            <div class="med-def-card-main">
                                <div class="med-def-card-title">💊 ${med.name}${!isActive ? " (pasif)" : ""}</div>
                                <div class="med-def-meta">${med.dosage || "Doz belirtilmedi"}${med.form ? ` • ${med.form}` : ""} • ${foodLabel}</div>
                                ${purpose ? `<div class="med-def-meta">${purpose}</div>` : ""}
                            </div>
                            ${headActions}
                        </div>
                        <div class="med-def-schedule-list">${scheduleHtml}</div>
                    </div>
                `;
            })
            .join("");
    }

    async function refresh() {
        const { formRoot, listRoot, toolbar, listDaily, listAll } = getEls(state.mode);

        if (state.mode === "kiosk") {
            renderKioskToolbar(toolbar);
        } else {
            renderFamilyAddButton(formRoot);
        }

        try {
            await loadMedications();
            if (state.mode === "kiosk" && listDaily && listAll) {
                // Aktif sekmenin listesine çiz
                const target = state.todayOnly ? listDaily : listAll;
                renderList(target);
                const other = state.todayOnly ? listAll : listDaily;
                if (other && other !== target) other.innerHTML = "";
            } else {
                renderList(listRoot);
            }
        } catch (error) {
            console.error(error);
            if (listRoot) {
                listRoot.innerHTML = `<p class="med-def-empty">İlaç listesi yüklenemedi: ${error.message}</p>`;
            }
        }
    }

    async function saveMedication(formRoot) {
        const editId = formRoot.querySelector("#medDefEditId")?.value || "";
        const name = formRoot.querySelector("#medDefName")?.value.trim();
        const purpose = formRoot.querySelector("#medDefPurpose")?.value.trim();
        const dosage = formRoot.querySelector("#medDefDosage")?.value.trim();
        const form = formRoot.querySelector("#medDefForm")?.value;
        const foodTiming = formRoot.querySelector("#medDefFoodTiming")?.value || "farketmez";
        const notesExtra = packNotes(purpose, foodTiming);
        const days = readSelectedDays(formRoot);
        const times = Array.from(formRoot.querySelectorAll(".medDefTimeInput"))
            .map((el) => el.value)
            .filter(Boolean);

        if (!name || times.length === 0) {
            alert("İlaç adı ve en az bir saat zorunludur.");
            return;
        }
        if (days.length === 0) {
            alert("En az bir gün seçmelisiniz.");
            return;
        }

        try {
            await ensureElder();
            const schedules = times.map((time_of_day) => ({
                time_of_day,
                days_of_week: days,
            }));

            if (editId) {
                const patchRes = await fetch(`${state.apiBaseUrl}/medications/${editId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name,
                        dosage: dosage || null,
                        form,
                        notes: notesExtra,
                    }),
                });
                const patchData = await patchRes.json().catch(() => ({}));
                if (!patchRes.ok) throw new Error(patchData.detail || "Güncellenemedi");

                // Mevcut saatleri silip yenilerini ekle
                const current = state.medications.find((m) => m.id === editId);
                for (const sch of current?.medication_schedules || []) {
                    await fetch(`${state.apiBaseUrl}/medications/schedules/${sch.id}`, {
                        method: "DELETE",
                    });
                }
                for (const sch of schedules) {
                    await fetch(`${state.apiBaseUrl}/medications/${editId}/schedules`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(sch),
                    });
                }
            } else {
                const response = await fetch(`${state.apiBaseUrl}/medications`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        elder_id: state.elderId,
                        name,
                        dosage: dosage || null,
                        form,
                        notes: notesExtra,
                        schedules,
                    }),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.detail || "İlaç kaydedilemedi.");
            }

            if (state.mode === "kiosk" || state.mode === "family") closeAddModal();
            await refresh();
            alert(editId ? "İlaç güncellendi." : "İlaç başarıyla tanımlandı.");
        } catch (error) {
            alert(error.message || "İlaç kaydedilirken hata oluştu.");
        }
    }

    async function createMedication(formRoot) {
        return saveMedication(formRoot);
    }

    async function deactivateMedication(medicationId) {
        if (!confirm("Bu ilacı pasifleştirmek istediğinize emin misiniz?")) return;

        try {
            const response = await fetch(`${state.apiBaseUrl}/medications/${medicationId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || "İlaç pasifleştirilemedi.");
            }
            await refresh();
        } catch (error) {
            alert(error.message);
        }
    }

    async function removeSchedule(scheduleId) {
        if (!confirm("Bu ilaç saatini silmek istiyor musunuz?")) return;

        try {
            const response = await fetch(`${state.apiBaseUrl}/medications/schedules/${scheduleId}`, {
                method: "DELETE",
            });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.detail || "Saat silinemedi.");
            }
            await refresh();
        } catch (error) {
            alert(error.message);
        }
    }

    async function markTaken(medicationId, scheduleId, medicationName, confirmedMethod = "manual") {
        try {
            await ensureElder();
            const formData = new FormData();
            formData.append("medication_id", medicationId);
            formData.append("status", "taken");
            formData.append("confirmed_method", confirmedMethod);
            if (scheduleId) {
                formData.append("schedule_id", scheduleId);
            }

            const response = await fetch(`${state.apiBaseUrl}/medication/log`, {
                method: "POST",
                body: formData,
            });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(data.detail || "İlaç kaydı oluşturulamadı.");
            }

            if (data?.data?.decision === "skipped") {
                alert(data.data.message || "Bu doz bugün zaten kaydedilmiş.");
            }

            await refresh();

            if (typeof appendMessageToUI === "function") {
                appendMessageToUI(`${medicationName} ilacı alındı olarak kaydedildi.`, "system");
            }
        } catch (error) {
            alert(error.message || "Bağlantı hatası.");
        }
    }

    function resolveUserContext(mode) {
        if (mode === "family") {
            return {
                userId: localStorage.getItem("elderly_id"),
                userName: localStorage.getItem("elderly_name") || "Yakınınız",
            };
        }

        const userId =
            localStorage.getItem("user_id") ||
            localStorage.getItem("elder_profile_id_fallback") ||
            `guest-${Date.now()}`;
        const userName =
            localStorage.getItem("user_name") ||
            localStorage.getItem("elderly_name") ||
            "Ahmet Amca";

        return { userId, userName };
    }

    async function init(options = {}) {
        state.mode = options.mode || "kiosk";
        state.todayOnly = options.todayOnly ?? state.mode === "kiosk";
        state.apiBaseUrl = options.apiBaseUrl || state.apiBaseUrl;

        const ctx = resolveUserContext(state.mode);
        state.userId = options.userId || ctx.userId;
        state.userName = options.userName || ctx.userName;
        // elder_id yalnızca mevcut kullanıcıya bağlıysa kullan
        const boundUserId = localStorage.getItem("elder_bound_user_id");
        const storedElderId = localStorage.getItem("elder_id");
        if (options.elderId) {
            state.elderId = options.elderId;
        } else if (storedElderId && boundUserId && boundUserId === state.userId) {
            state.elderId = storedElderId;
        } else {
            state.elderId = null;
        }

        try {
            await ensureElder();
        } catch (error) {
            console.error("Yaşlı profili eşleştirilemedi:", error);
        }

        await refresh();
    }

    function setTodayOnly(todayOnly) {
        state.todayOnly = Boolean(todayOnly);
        return refresh();
    }

    return {
        init,
        refresh,
        markTaken,
        deactivateMedication,
        removeSchedule,
        openAddModal,
        openEditModal,
        closeAddModal,
        toggleActive,
        setTodayOnly,
        getElderId: () => state.elderId,
    };
})();
