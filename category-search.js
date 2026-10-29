/* Ataya: searchable Arabic categories, derived from existing beneficiaries.
   No separate category database, so existing stored values and permissions remain intact. */
(() => {
    "use strict";
    const limit = 40;
    const normalize = text => String(text || "")
        .trim()
        .replace(/[\u064B-\u065F\u0670]/g, "")
        .replace(/[أإآٱ]/g, "ا")
        .replace(/ة/g, "ه").replace(/ى/g, "ي")
        .replace(/ؤ/g, "و").replace(/ئ/g, "ي")
        .replace(/\s+/g, " ").toLowerCase()
        .replace(/^ال(?=\S{2})/, "");

    const controls = [];
    let outsideListenerAdded = false;

    const splitCategories = value => {
        const seen = new Set();
        return String(value || "").split(/[,،؛;\n]+/).map(s => s.trim().replace(/\s+/g, " "))
            .filter(s => { const key = normalize(s); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    };

    function categories() {
        const map = new Map();
        const records = typeof beneficiaries === "undefined" ? [] : beneficiaries;
        for (const item of records) {
            for (const name of splitCategories(item?.category)) {
                const key = normalize(name);
                if (!map.has(key)) map.set(key, { name, count: 0 });
                map.get(key).count++;
            }
        }
        return Array.from(map.values())
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ar"));
    }

    function canonicalCategory(value) {
        const current = categories();
        const parts = splitCategories(value).map(name => current.find(c => normalize(c.name) === normalize(name))?.name || name);
        return parts.length ? parts.join("، ") : "عام";
    }

    function create(kind, input, select) {
        if (!input || input.dataset.categoryPickerReady) return;
        input.dataset.categoryPickerReady = "1";
        input.autocomplete = "off";
        input.setAttribute("role", "combobox");
        input.setAttribute("aria-autocomplete", "list");
        input.setAttribute("aria-expanded", "false");
        const root = document.createElement("div");
        root.className = "ataya-category-picker";
        input.parentNode.insertBefore(root, input);
        root.appendChild(input);
        const menu = document.createElement("div");
        menu.className = "ataya-category-menu";
        menu.hidden = true;
        menu.setAttribute("role", "listbox");
        menu.id = "category-list-" + (input.id || kind);
        input.setAttribute("aria-controls", menu.id);
        root.appendChild(menu);

        const ctrl = { kind, input, select, root, menu, visible: [], active: 0 };
        controls.push(ctrl);

        function hide() {
            menu.hidden = true;
            input.setAttribute("aria-expanded", "false");
            input.removeAttribute("aria-activedescendant");
        }

        function choose(item) {
            if (!item) return;
            if (kind === "entry") {
                const fragments = String(input.value || "").split(/[,،؛;\n]+/);
                fragments.pop(); // Replace only the category being typed; preserve earlier selections.
                input.value = canonicalCategory([...fragments, item.name].join("، "));
            } else {
                input.value = item.name;
            }
            if (select) {
                select.value = item.value;
                select.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                input.dispatchEvent(new Event("change", { bubbles: true }));
            }
            hide();
        }

        function render(showAll = false) {
            const lastCategory = kind === "entry" ? String(input.value || "").split(/[,،؛;\n]+/).pop() : input.value;
            const search = showAll ? "" : normalize(lastCategory);
            let available = categories();
            let entries;
            if (kind === "entry") {
                entries = available
                    .filter(c => !search || normalize(c.name).includes(search))
                    .sort((a, b) => {
                        const aName = normalize(a.name), bName = normalize(b.name);
                        const ar = aName === search ? 0 : aName.startsWith(search) ? 1 : 2;
                        const br = bName === search ? 0 : bName.startsWith(search) ? 1 : 2;
                        return ar - br || b.count - a.count || a.name.localeCompare(b.name, "ar");
                    })
                    .map(c => ({ ...c, value: c.name }));
            } else {
                entries = [];
                if (!search) entries.push({ name: kind === "dist" ? "كل الفئات" : "جميع الفئات", value: select.options[0]?.value || "", count: null });
                entries.push(...available.filter(c => !search ||
                    normalize(c.name).includes(search)).map(c => ({ ...c, value: c.name })));
            }
            const exact = available.find(c => normalize(c.name) === search);
            ctrl.visible = entries.slice(0, limit);
            ctrl.active = 0;
            menu.replaceChildren();
            if (kind === "entry") {
                const title = document.createElement("p");
                title.className = "ataya-category-heading";
                title.textContent = available.length + " صفة مسجلة — اختر أو أضف أكثر من صفة بالفاصلة «،»";
                menu.appendChild(title);
            }
            if (!ctrl.visible.length) {
                const message = document.createElement("p");
                message.className = "ataya-category-empty";
                message.textContent = "لا توجد فئة مطابقة للبحث";
                menu.appendChild(message);
            }
            ctrl.visible.forEach((item, i) => {
                const row = document.createElement("button");
                row.type = "button";
                row.id = menu.id + "-row-" + i;
                row.className = "ataya-category-item";
                row.setAttribute("role", "option");
                row.setAttribute("aria-selected", i === ctrl.active ? "true" : "false");
                const text = document.createElement("span");
                text.textContent = item.name;
                row.appendChild(text);
                if (item.count !== null) {
                    const count = document.createElement("small");
                    count.textContent = item.count + " مستفيد";
                    row.appendChild(count);
                }
                row.addEventListener("mousedown", event => event.preventDefault());
                row.addEventListener("click", () => choose(item));
                menu.appendChild(row);
            });
            if (kind === "entry" && search && !exact) {
                const add = document.createElement("button");
                add.type = "button";
                add.className = "ataya-category-new";
                add.textContent = 'استخدام صفة جديدة: «' + String(lastCategory).trim().slice(0, 75) + '»';
                add.addEventListener("mousedown", event => event.preventDefault());
                add.addEventListener("click", () => {
                    input.value = canonicalCategory(input.value);
                    hide();
                });
                menu.appendChild(add);
            }
            if (entries.length > limit) {
                const more = document.createElement("p");
                more.className = "ataya-category-heading";
                more.textContent = "توجد نتائج إضافية؛ اكتب جزءًا من اسم الفئة لتضييق البحث.";
                menu.appendChild(more);
            }
            menu.hidden = false;
            input.setAttribute("aria-expanded", "true");
            updateActive();
        }

        function updateActive() {
            const rows = menu.querySelectorAll(".ataya-category-item");
            rows.forEach((row, i) => row.setAttribute("aria-selected", i === ctrl.active ? "true" : "false"));
            if (rows[ctrl.active]) {
                input.setAttribute("aria-activedescendant", rows[ctrl.active].id);
                rows[ctrl.active].scrollIntoView({ block: "nearest" });
            } else input.removeAttribute("aria-activedescendant");
        }

        input.addEventListener("focus", () => {
            if (select) input.select();
            render(true);
        });
        input.addEventListener("input", () => render());
        input.addEventListener("keydown", event => {
            if (event.key === "Escape") { hide(); return; }
            if (menu.hidden) {
                if (event.key === "ArrowDown") { event.preventDefault(); render(); }
                return;
            }
            if (event.key === "ArrowDown" && ctrl.visible.length) {
                event.preventDefault(); ctrl.active = (ctrl.active + 1) % ctrl.visible.length; updateActive();
            } else if (event.key === "ArrowUp" && ctrl.visible.length) {
                event.preventDefault(); ctrl.active = (ctrl.active - 1 + ctrl.visible.length) % ctrl.visible.length; updateActive();
            } else if (event.key === "Enter") {
                event.preventDefault();
                if (kind === "entry") {
                    const last = String(input.value || "").split(/[,،؛;\n]+/).pop().trim();
                    const active = ctrl.visible[ctrl.active];
                    if (active && normalize(active.name) === normalize(last)) choose(active);
                    else { input.value = canonicalCategory(input.value); hide(); }
                } else if (ctrl.visible[ctrl.active]) choose(ctrl.visible[ctrl.active]);
                else hide();
            }
        });

        input.addEventListener("blur", () => {
            setTimeout(() => {
                if (!root.contains(document.activeElement)) hide();
                if (kind === "entry" && input.value.trim()) input.value = canonicalCategory(input.value);
                if (select && menu.hidden) {
                    const current = Array.from(select.options).find(o => o.value === select.value);
                    input.value = current?.textContent || select.options[0]?.textContent || "";
                }
            }, 120);
        });
        if (!outsideListenerAdded) {
            outsideListenerAdded = true;
            document.addEventListener("pointerdown", event => {
                for (const c of controls) {
                    if (!c.root.contains(event.target)) {
                        c.menu.hidden = true;
                        c.input.setAttribute("aria-expanded", "false");
                    }
                }
            });
        }
        return ctrl;
    }


    // Smart multi-select for beneficiary entry. Keep the legacy comma-separated
    // category string in #benCategory for Firebase, exports and old records.
    let multiEntry = null;
    function createEntry() {
        const store = document.getElementById("benCategory");
        const input = document.getElementById("benCategoryQuery");
        const chips = document.getElementById("benCategoryChips");
        const menu = document.getElementById("benCategorySuggestions");
        const root = document.getElementById("benCategoryPicker");
        if (!store || !input || !chips || !menu || !root || input.dataset.multiReady) return;
        input.dataset.multiReady = "1";
        input.setAttribute("aria-controls", menu.id);
        let selected = [];
        let visible = [];
        let active = 0;

        function hide() {
            menu.hidden = true;
            input.setAttribute("aria-expanded", "false");
            input.removeAttribute("aria-activedescendant");
        }
        function persist() {
            store.value = selected.join("، ");
            store.dispatchEvent(new Event("change", {bubbles: true}));
        }
        function showChips() {
            chips.replaceChildren();
            selected.forEach((category, index) => {
                const tag = document.createElement("span");
                tag.className = "inline-flex items-center gap-1 rounded-lg bg-indigo-100 text-indigo-900 px-2 py-1 text-xs font-semibold";
                const name = document.createElement("span");
                name.textContent = category;
                const remove = document.createElement("button");
                remove.type = "button";
                remove.className = "rounded px-1 hover:bg-indigo-200";
                remove.textContent = "×";
                remove.setAttribute("aria-label", "إزالة صفة " + category);
                remove.addEventListener("click", () => {
                    selected.splice(index, 1);
                    persist();
                    showChips();
                    input.focus();
                    renderSuggestions();
                });
                tag.append(name, remove);
                chips.appendChild(tag);
            });
        }
        function addOne(value, focus = true) {
            const parts = splitCategories(value);
            const known = categories();
            for (const part of parts) {
                const original = known.find(c => normalize(c.name) === normalize(part))?.name || part;
                if (!selected.some(s => normalize(s) === normalize(original))) selected.push(original);
            }
            persist();
            showChips();
            input.value = "";
            if (focus) input.focus();
            renderSuggestions();
        }
        function commit() {
            const raw = input.value.trim();
            if (raw) addOne(raw, false);
            hide();
        }
        function syncFromStore() {
            selected = splitCategories(store.value);
            input.value = "";
            showChips();
            hide();
        }
        function renderSuggestions() {
            const query = normalize(input.value);
            visible = categories().filter(c => !selected.some(s => normalize(s) === normalize(c.name)) &&
                (!query || normalize(c.name).includes(query))).slice(0, 30);
            active = 0;
            menu.replaceChildren();
            const heading = document.createElement("p");
            heading.className = "ataya-category-heading";
            heading.textContent = query ? "صفات مطابقة — اختر صفة أو أضف جديدة" : "اختر صفة من المسجلين أو اكتب صفة جديدة";
            menu.appendChild(heading);
            visible.forEach((item, index) => {
                const row = document.createElement("button");
                row.type = "button";
                row.className = "ataya-category-item";
                row.id = menu.id + "-" + index;
                row.setAttribute("role", "option");
                row.setAttribute("aria-selected", index === active ? "true" : "false");
                const name = document.createElement("span");
                name.textContent = item.name;
                const count = document.createElement("small");
                count.textContent = item.count + " مستفيد";
                row.append(name, count);
                row.addEventListener("pointerdown", e => e.preventDefault());
                row.addEventListener("click", () => addOne(item.name));
                menu.appendChild(row);
            });
            if (input.value.trim() && !selected.some(s => normalize(s) === query) &&
                    !categories().some(c => normalize(c.name) === query)) {
                const add = document.createElement("button");
                add.type = "button";
                add.className = "ataya-category-new";
                add.textContent = "＋ إضافة صفة جديدة: «" + input.value.trim().slice(0, 70) + "»";
                add.addEventListener("pointerdown", e => e.preventDefault());
                add.addEventListener("click", () => addOne(input.value));
                menu.appendChild(add);
            }
            if (!visible.length && !input.value.trim()) {
                const empty = document.createElement("p");
                empty.className = "ataya-category-empty";
                empty.textContent = "اكتب صفة لإضافتها";
                menu.appendChild(empty);
            }
            if (visible.length === 30) {
                const more = document.createElement("p");
                more.className = "ataya-category-heading";
                more.textContent = "اكتب جزءًا من الصفة لعرض المزيد";
                menu.appendChild(more);
            }
            menu.hidden = false;
            input.setAttribute("aria-expanded", "true");
        }
        input.addEventListener("focus", renderSuggestions);
        input.addEventListener("input", () => {
            if (/[,،؛;\n]/.test(input.value)) {
                const fragments = input.value.split(/[,،؛;\n]+/);
                const trailing = fragments.pop() || "";
                const completed = fragments.join("، ");
                if (completed.trim()) addOne(completed, false);
                input.value = trailing;
            }
            renderSuggestions();
        });
        input.addEventListener("keydown", event => {
            if (event.key === "Escape") { hide(); return; }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (menu.hidden) renderSuggestions();
                if (visible.length) {
                    active = (active + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
                    menu.querySelectorAll('[role="option"]').forEach((item, index) => {
                        item.setAttribute("aria-selected", index === active ? "true" : "false");
                        if (index === active) item.scrollIntoView({block: "nearest"});
                    });
                }
            } else if (event.key === "Enter") {
                event.preventDefault();
                if (input.value.trim()) {
                    const exact = visible.find(c => normalize(c.name) === normalize(input.value));
                    addOne(exact?.name || (active > 0 ? visible[active]?.name : null) || input.value);
                }
            } else if (event.key === "Tab") {
                commit();
            } else if (event.key === "Backspace" && !input.value && selected.length) {
                selected.pop(); persist(); showChips();
            }
        });
        input.addEventListener("blur", () => setTimeout(() => {
            if (!root.contains(document.activeElement)) commit();
        }, 150));
        document.addEventListener("pointerdown", event => {
            if (!root.contains(event.target)) hide();
        });
        multiEntry = {sync: syncFromStore, commit, refresh: () => {
            if (!menu.hidden) renderSuggestions();
        }};
        syncFromStore();
    }

    function createSelect(id, searchId, kind) {
        const select = document.getElementById(id);
        if (!select || document.getElementById(searchId)) return;
        const search = document.createElement("input");
        search.type = "search";
        search.id = searchId;
        search.className = "w-full p-2 border border-slate-300 rounded-lg text-sm bg-white";
        search.placeholder = "ابحث في الفئات...";
        search.setAttribute("aria-label", "بحث الفئات");
        select.parentNode.insertBefore(search, select);
        select.classList.add("ataya-category-native");
        const ctrl = create(kind, search, select);
        const active = Array.from(select.options).find(o => o.value === select.value);
        ctrl.input.value = active?.textContent || select.options[0]?.textContent || "";
    }

    function initialize() {
        createEntry();
        createSelect("distCategorySelect", "atayaCategorySearchDist", "dist");
        createSelect("filterCategory", "atayaCategorySearchReport", "report");
    }

    function refresh() {
        multiEntry?.refresh();
        controls.forEach(ctrl => {
            if (ctrl.select && (ctrl.menu.hidden || document.activeElement !== ctrl.input)) {
                const chosen = Array.from(ctrl.select.options).find(o => o.value === ctrl.select.value);
                ctrl.input.value = chosen?.textContent || ctrl.select.options[0]?.textContent || "";
            }
            if (!ctrl.menu.hidden) ctrl.input.dispatchEvent(new Event("input"));
        });
    }

    window.AtayaCategories = { initialize, refresh, canonicalCategory,
        syncEntry: () => multiEntry?.sync(), commitEntry: () => multiEntry?.commit() };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
