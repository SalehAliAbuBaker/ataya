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
        .replace(/\s+/g, " ").toLowerCase();

    const controls = [];
    let outsideListenerAdded = false;

    function categories() {
        const map = new Map();
        const records = typeof beneficiaries === "undefined" ? [] : beneficiaries;
        for (const item of records) {
            const name = String(item?.category || "").trim();
            const key = normalize(name);
            if (!key) continue;
            if (!map.has(key)) map.set(key, { name, count: 0 });
            map.get(key).count++;
        }
        return Array.from(map.values())
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ar"));
    }

    function canonicalCategory(value) {
        const typed = String(value || "").trim().replace(/\s+/g, " ");
        if (!typed) return "عام";
        const existing = categories().find(item => normalize(item.name) === normalize(typed));
        return existing?.name || typed;
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
            input.value = item.name;
            if (select) {
                select.value = item.value;
                select.dispatchEvent(new Event("change", { bubbles: true }));
            } else {
                input.dispatchEvent(new Event("change", { bubbles: true }));
            }
            hide();
        }

        function render(showAll = false) {
            const search = showAll ? "" : normalize(input.value);
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
                title.textContent = available.length + " فئة مسجلة — اختر فئة أو اكتب فئة جديدة";
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
                add.textContent = 'استخدام فئة جديدة: «' + input.value.trim().slice(0, 75) + '»';
                add.addEventListener("mousedown", event => event.preventDefault());
                add.addEventListener("click", () => {
                    input.value = input.value.trim().replace(/\s+/g, " ");
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
                if (ctrl.visible[ctrl.active] && (kind !== "entry" ||
                    !input.value.trim() || normalize(ctrl.visible[ctrl.active].name) === normalize(input.value) ||
                    !ctrl.visible.some(item => normalize(item.name) === normalize(input.value)))) {
                    choose(ctrl.visible[ctrl.active]);
                } else {
                    if (kind === "entry") input.value = canonicalCategory(input.value);
                    hide();
                }
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
        create("entry", document.getElementById("benCategory"), null);
        createSelect("distCategorySelect", "atayaCategorySearchDist", "dist");
        createSelect("filterCategory", "atayaCategorySearchReport", "report");
    }

    function refresh() {
        controls.forEach(ctrl => {
            if (ctrl.select && (ctrl.menu.hidden || document.activeElement !== ctrl.input)) {
                const chosen = Array.from(ctrl.select.options).find(o => o.value === ctrl.select.value);
                ctrl.input.value = chosen?.textContent || ctrl.select.options[0]?.textContent || "";
            }
            if (!ctrl.menu.hidden) ctrl.input.dispatchEvent(new Event("input"));
        });
    }

    window.AtayaCategories = { initialize, refresh, canonicalCategory };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
    else initialize();
})();
