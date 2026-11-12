// ==UserScript==
// @name        PinnaCle 2.0: Enhanced
// @namespace   Violentmonkey Scripts
// @icon        https://pinnacle.pnc.edu.ph/img/favicon.ico
// @version     1.9.4
//
// @match       https://pinnacle.pnc.edu.ph/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
//
// @author      kurtlvc.github.io
// @description Enhances your lms experience!
// ==/UserScript==

(function () {
    'use strict';

    // Module-level state (explicitly declared, not implicit globals)
    let pinnacle = null;

    // Pending-tasks cache: avoids re-fetching every class's posts on every
    // modal open. Keyed on the sorted list of class IDs so a semester/
    // schedule change busts it automatically.
    let pendingTasksCache = { key: null, timestamp: 0, data: null };
    const PENDING_TASKS_TTL_MS = 1 * 60 * 1000; // 3 minutes

    // Dedupes the background fetch that keeps pending-tasks data current —
    // shared between refreshPendingTaskBadge and renderPendingTasks (see
    // revalidatePendingTasks) so that a badge refresh firing right as the
    // modal opens doesn't kick off two full "fetch every class's posts"
    // runs at once; both just await the same in-flight promise.
    let pendingTasksRefreshInFlight = null;

    // /student/references returns every enrolled class's files/links in one
    // shot (props.schedules[].files / .links), each tagged with the post_id
    // it belongs to. This is far cheaper than fetching each post's own
    // detail page just to read its attachments, so we fetch it once, flatten
    // it into a post_id -> {files, links} map, and cache it briefly.
    //
    // CONFIRMED GAP: Assignment-type posts (type_id === ASSIGNMENT_TYPE_ID)
    // are NOT included in /student/references at all — their files/links
    // only exist on the post's own detail page (Student/PostPage,
    // /student/class/{classId}/post/{urlKey}, under props.files/props.links).
    // See fetchPostAttachments below for how those are backfilled.
    let attachmentsCache = { timestamp: 0, data: null };
    const ATTACHMENTS_TTL_MS = 1 * 60 * 1000; // 5 minutes

    // Non-Material posts' own attachments (see gap noted above). Fetched
    // lazily, per post, after the card is already rendered — not batched
    // up front — since a dashboard can have many assignment posts across
    // many classes and we don't want to fire dozens of requests at once
    // just to paint the initial page. Concurrency for these fetches is
    // capped by the shared global gate (see requestWithRetry below), same
    // as every other Pinnacle request this script makes.
    let postAttachmentsCache = new Map(); // postId -> { timestamp, data: {files, links} }
    const POST_ATTACHMENTS_TTL_MS = 1 * 60 * 1000; // 10 minutes — a single post's own attachments change rarely


    // How long a class's posts stay fresh before we refetch. Same trade-off
    // as the caches above: shorter = sees new posts/deadline edits sooner,
    // longer = fewer requests. 5 min means a just-posted assignment can take
    // up to that long to show up here (still fine, since the real site is
    // always one click away for anything urgent).
    const CLASS_POSTS_TTL_MS = 1 * 60 * 1000; // 5 minutes

    // --- Settings module (merged in from the standalone "Setting module
    // for pinnacle enhanced" userscript) ---------------------------------
    const UI_SETTINGS_KEY = "pinnacle_enhanced_ui_settings";

    const UI_SELECTORS = {
        navbarRow: "#app > nav > div > div",
        sidebarRow: "#app > div.d-flex > aside > div > div.text-muted.px-4.py-2",
    };

    const INJECTED_UI_IDS = [
        "enhancerSettingsBtn",
        "nav-enhancerMenu",
        "enhancerSettingsModal",
        "enhancerMenuModal",
    ];

    const DEFAULT_UI_SETTINGS = {
        compactSidebar: false,
        highlightActive: true,
        showPageTiming: false,
        hideNameNavbar: false,
        // "all" or a stringified type_id (see POST_TYPE_META further down).
        // Kept as a literal "2" rather than referencing ASSIGNMENT_TYPE_ID
        // here on purpose — this object literal runs immediately when the
        // script loads, before that const's own declaration line has run,
        // so referencing it here would throw a TDZ error. "2" is the same
        // value ASSIGNMENT_TYPE_ID is assigned below.
        defaultPostTypeFilter: "2",
        // false = past-due posts start hidden on each class card (the new
        // default); true = they start shown, same as every version before
        // this setting existed.
        showPastDueByDefault: false,
        // false = already-submitted Assignments/Online Tests start hidden
        // on each class card; true = they start shown.
        showSubmittedWorkByDefault: false,
        // macOS-style frosted loading overlay shown during page navigation.
        macLoadScreen: true,
        // id from THEMES (see the remote theme module below), or "none".
        themeId: "none",
    };

    function loadUISettings() {
        try {
            return { ...DEFAULT_UI_SETTINGS, ...(GM_getValue(UI_SETTINGS_KEY, {}) || {}) };
        } catch (err) {
            console.warn("PinnaCle Enhanced: failed to read UI settings:", err);
            return { ...DEFAULT_UI_SETTINGS };
        }
    }

    function saveUISettings(settings) {
        try {
            GM_setValue(UI_SETTINGS_KEY, settings);
        } catch (err) {
            console.warn("PinnaCle Enhanced: failed to save UI settings:", err);
        }
        applyUISettings(settings);
        remoteTheme.sync(settings.themeId, { force: true, notify: true });
    }

    function applyUISettings(settings) {
        const root = document.documentElement;
        root.classList.toggle("pe-compact-sidebar", !!settings.compactSidebar);
        root.classList.toggle("pe-highlight-active", !!settings.highlightActive);
        root.classList.toggle("pe-page-timing", !!settings.showPageTiming);
        root.classList.toggle("pe-hide-name", !!settings.hideNameNavbar);
        if (!settings.macLoadScreen) macLoad.hide();
    }

    function injectUIGlobalStyles() {
        if (document.getElementById("pinnacleEnhancerUIStyles")) return;
        const style = document.createElement("style");
        style.id = "pinnacleEnhancerUIStyles";
        style.textContent = `
        html.pe-compact-sidebar #app aside { width: 220px !important; font-size: .9rem; }
        /* main's margin-left/width are normally driven by the site's own
           JS to match the sidebar's actual width — they're inline styles,
           not CSS-rule-derived, so shrinking the aside above doesn't move
           these on its own. Mirror the same 220px here so content isn't
           left with either a gap or an overlap under the sidebar. */
        html.pe-compact-sidebar #app main {
            margin-left: 220px !important;
            width: calc(100% - 220px) !important;
        }
        /* footer has the same sidebar-width-dependent inline margin/width
           as main, so it needs the same override or it's left indented
           for the old (wider) sidebar width while main and aside shrink. */
        html.pe-compact-sidebar #app footer {
            margin-left: 220px !important;
            width: calc(100% - 220px) !important;
        }
        /* The header logo has its own inline width (210px by default) and
           doesn't scale with the sidebar either, so it can overflow/look
           oversized once the sidebar itself is narrower. */
        html.pe-compact-sidebar #app aside .ucpnc-header { width: 180px !important; }
        html.pe-highlight-active #app aside .nav-link.active {
            box-shadow: inset 3px 0 0 var(--bs-success);
        }
        html.pe-hide-name #app > nav > div > b { opacity: 0; }
        #enhancerTimingBadge { display: none; }
        html.pe-page-timing #enhancerTimingBadge { display: inline-block; }
        `;
        document.head.appendChild(style);
    }

    function settingsUIManager(page) {
        const navbarRow = document.querySelector(UI_SELECTORS.navbarRow);
        const sidebarRow = document.querySelector(UI_SELECTORS.sidebarRow);
        if (!navbarRow || !sidebarRow) {
            console.warn("PinnaCle Enhanced: navbar/sidebar not found yet, skipping settings UI.");
            return;
        }

        cleanupInjectedUI();

        document.body.append(
            customModal(settingsModalOptions()),
            customModal(menuModalOptions(page)),
        );

        navbarRow.appendChild(customButton({
            id: "enhancerSettingsBtn",
            title: "Enhancer Settings",
            faIcon: "fa-gear",
            onClick: () => showModal("enhancerSettingsModal"),
        }));

        sidebarRow.insertAdjacentElement("afterend", customNavButton({
            id: "enhancerMenu",
            text: "PinnaCle Enhanced",
            icon: "fa-fire",
            onClick: () => showModal("enhancerMenuModal"),
        }));
    }

    function cleanupInjectedUI() {
        INJECTED_UI_IDS.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.classList.contains("modal") && window.bootstrap?.Modal) {
                window.bootstrap.Modal.getInstance(el)?.hide();
            }
            el.remove();
        });
    }

    function showModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        if (window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(el).show();
        } else {
            console.warn("PinnaCle Enhanced: bootstrap.Modal unavailable — using fallback");
            el.classList.add("show", "d-block");
            document.body.classList.add("modal-open");
            const backdrop = document.createElement("div");
            backdrop.className = "modal-backdrop fade show";
            document.body.appendChild(backdrop);
            const close = () => {
                el.classList.remove("show", "d-block");
                document.body.classList.remove("modal-open");
                backdrop.remove();
            };
            el.querySelectorAll("[data-bs-dismiss='modal']")
                .forEach((b) => b.addEventListener("click", close, { once: true }));
            backdrop.addEventListener("click", close, { once: true });
        }
    }

    function updateTimingBadge(ms) {
        const navbarRow = document.querySelector(UI_SELECTORS.navbarRow);
        if (!navbarRow) return;
        let badge = document.getElementById("enhancerTimingBadge");
        if (!badge || !badge.isConnected) {
            badge = document.createElement("span");
            badge.id = "enhancerTimingBadge";
            badge.className = "badge text-bg-secondary ms-2";
            navbarRow.appendChild(badge);
        }
        badge.textContent = `${Math.round(ms)} ms`;
    }

    function createFetchStudentButton() {
        const wrap = document.createElement("div");
        wrap.className = "d-flex flex-column gap-2";

        const button = document.createElement("input");
        button.id = "inpFetchStudent";
        button.type = "button";
        button.className = "btn btn-sm btn-outline-secondary text-start";
        button.value = "Fetch your student data to see how it works";

        const output = document.createElement("pre");
        output.id = "fetchStudentOutput";
        output.style.maxHeight = "300px";
        output.style.overflow = "auto";
        output.style.background = "#070505";
        output.style.padding = "0.5rem";
        output.style.marginTop = "0.25rem";
        output.style.fontSize = "0.75rem";
        output.style.display = "none";

        button.addEventListener("click", async () => {
            button.disabled = true;
            button.value = "Fetching...";
            output.style.display = "block";
            output.textContent = "Loading...";

            try {
                const result = await fetchInertiaPage("/student");
                output.textContent = JSON.stringify(result, null, 2);
                console.log("/student response:", result);
            } catch (err) {
                output.textContent = "Error: " + err.message;
                console.error("Fetch /student failed:", err);
            } finally {
                button.disabled = false;
                button.value = "Fetch your student data to see how it works";
            }
        });

        wrap.append(button, output);
        return wrap;
    }

    function createRefetchEverythingButton() {
        const button = document.createElement("button");
        button.id = "inpRefetchAll";
        button.type = "button";
        button.className = "btn btn-sm btn-outline-danger text-start";
        button.innerHTML = '<i class="fa-solid fa-rotate me-2"></i>Re-fetch everything';

        button.addEventListener("click", () => {
            const ok = confirm(
                "This clears every cached class post, attachment, and pending-task list, then refetches the current page's data. Continue?"
            );
            if (!ok) return;

            button.disabled = true;
            button.textContent = "Refreshing...";
            clearAllPinnacleCaches();

            const triggered = softRefreshCurrentPage();
            if (!triggered) {
                console.warn("PinnaCle Enhanced: no soft-refresh path found, falling back to a full reload.");
                location.reload();
                return;
            }

            setTimeout(() => {
                button.disabled = false;
                button.innerHTML = '<i class="fa-solid fa-rotate me-2"></i>Re-fetch everything';
            }, 5000);
        });

        return button;
    }

    function settingsModalOptions() {
        const switches = [
            { key: "compactSidebar", label: "Compact sidebar" },
            { key: "highlightActive", label: "Highlight active sidebar item" },
            { key: "showPageTiming", label: "Show page load timing badge" },
            { key: "hideNameNavbar", label: "Hide your name in the navbar" },
            { key: "showPastDueByDefault", label: "Show past-due posts by default on homepage class cards" },
            { key: "showSubmittedWorkByDefault", label: "Show submitted works by default on homepage class cards" },
            { key: "macLoadScreen", label: "macOS-style loading screen when switching pages" },
        ];

        const body = document.createElement("div");
        const current = loadUISettings();

        // Default post type shown per class card (see buildClassCard). "All
        // types" plus one option per POST_TYPE_META entry, in the same
        // fixed order they're defined there — not derived from what's
        // actually posted anywhere, since this setting applies globally
        // across every class, not just the one card someone happened to
        // have open when they changed it.
        const postTypeWrap = document.createElement("div");
        postTypeWrap.className = "mb-3";

        const postTypeLabel = document.createElement("label");
        postTypeLabel.className = "form-label small text-muted mb-1";
        postTypeLabel.htmlFor = "peSetting-defaultPostTypeFilter";
        postTypeLabel.textContent = "Default post type shown in class cards";

        const postTypeSelect = document.createElement("select");
        postTypeSelect.className = "form-select form-select-sm";
        postTypeSelect.id = "peSetting-defaultPostTypeFilter";
        postTypeSelect.dataset.peSetting = "defaultPostTypeFilter";

        const allTypesOption = document.createElement("option");
        allTypesOption.value = "all";
        allTypesOption.textContent = "All types";
        postTypeSelect.appendChild(allTypesOption);

        Object.entries(POST_TYPE_META).forEach(([typeId, meta]) => {
            const opt = document.createElement("option");
            opt.value = typeId;
            opt.textContent = `${meta.icon} ${meta.label}`;
            postTypeSelect.appendChild(opt);
        });

        postTypeSelect.value = String(current.defaultPostTypeFilter ?? "2");

        const postTypeHint = document.createElement("small");
        postTypeHint.className = "text-muted d-block mt-1";
        postTypeHint.textContent = "If a class has no posts of this type, its card falls back to \"All types\" instead.";

        postTypeWrap.append(postTypeLabel, postTypeSelect, postTypeHint);
        body.appendChild(postTypeWrap);

        // Remote CSS theme (see remoteTheme). Options come from THEMES.
        const themeWrap = document.createElement("div");
        themeWrap.className = "mb-3";

        const themeLabel = document.createElement("label");
        themeLabel.className = "form-label small text-muted mb-1";
        themeLabel.htmlFor = "peSetting-themeId";
        themeLabel.textContent = "Theme";

        const themeSelect = document.createElement("select");
        themeSelect.className = "form-select form-select-sm";
        themeSelect.id = "peSetting-themeId";
        themeSelect.dataset.peSetting = "themeId";

        const noThemeOption = document.createElement("option");
        noThemeOption.value = "none";
        noThemeOption.textContent = "Default (no theme)";
        themeSelect.appendChild(noThemeOption);

        THEMES.forEach((t) => {
            const opt = document.createElement("option");
            opt.value = t.id;
            opt.textContent = t.label;
            themeSelect.appendChild(opt);
        });

        themeSelect.value = THEMES.some((t) => t.id === current.themeId) ? current.themeId : "none";

        const themeHint = document.createElement("small");
        themeHint.className = "text-muted d-block mt-1";
        themeHint.textContent = "Downloaded once and saved in your browser, so it applies instantly on every page. Refreshed automatically every few hours and each time you press Save.";

        themeWrap.append(themeLabel, themeSelect, themeHint);
        body.appendChild(themeWrap);

        switches.forEach(({ key, label }) => {
            const wrap = document.createElement("div");
            wrap.className = "form-check form-switch mb-2";

            const input = document.createElement("input");
            input.type = "checkbox";
            input.className = "form-check-input";
            input.id = `peSetting-${key}`;
            input.dataset.peSetting = key;
            input.checked = !!current[key];

            const labelEl = document.createElement("label");
            labelEl.className = "form-check-label";
            labelEl.htmlFor = input.id;
            labelEl.textContent = label;

            wrap.append(input, labelEl);
            body.appendChild(wrap);
        });

        const hint = document.createElement("small");
        hint.className = "text-muted d-block mt-3";
        hint.textContent = "Changes apply immediately after Save; some (like the sidebar width) may need a page refresh to fully settle.";
        body.appendChild(hint);

        const cacheActions = document.createElement("div");
        cacheActions.className = "border-top mt-4 pt-3";
        const cacheTitle = document.createElement("h6");
        cacheTitle.textContent = "Data";
        cacheTitle.className = "mb-2";
        cacheActions.appendChild(cacheTitle);
        cacheActions.appendChild(createRefetchEverythingButton());
        body.appendChild(cacheActions);

        return {
            id: "enhancerSettingsModal",
            title: "Enhancer Settings",
            icon: "fa-gear",
            content: body,
            footerButtons: [
                {
                    label: "Save",
                    variant: "success",
                    dismiss: true,
                    onClick: (e) => {
                        const modalEl = e.target.closest(".modal");
                        const next = { ...loadUISettings() };
                        modalEl.querySelectorAll("[data-pe-setting]").forEach((el) => {
                            const key = el.dataset.peSetting;
                            if (el.tagName === "SELECT") {
                                next[key] = el.value;
                            } else if (el.type === "checkbox") {
                                next[key] = el.checked;
                            }
                        });
                        saveUISettings(next);
                        showToast("Settings saved.", "success", 3000);
                    },
                },
                { label: "Close", variant: "secondary", dismiss: true },
            ],
        };
    }

    function menuModalOptions(page) {
        const body = document.createElement("div");

        const info = document.createElement("p");
        info.className = "mb-3 text-muted";
        info.textContent = page ? `Current page: ${page.component ?? "unknown"}` : "Current page: (initial load)";
        body.appendChild(info);

        const actionsWrap = document.createElement("div");
        actionsWrap.className = "d-flex flex-column gap-2 mb-3";

        const btnSavePostsMarkdown = document.createElement("button");
        btnSavePostsMarkdown.type = "button";
        btnSavePostsMarkdown.className = "btn btn-sm btn-outline-secondary text-start";
        btnSavePostsMarkdown.innerHTML = '<i class="fa-solid fa-file-export me-2"></i>Save Class Posts as Markdown for archival';
        btnSavePostsMarkdown.addEventListener("click", () => runFileExport(btnSavePostsMarkdown, exportClassPostsMarkdown));
        actionsWrap.appendChild(btnSavePostsMarkdown);

        const btnSavePostsCSV = document.createElement("button");
        btnSavePostsCSV.type = "button";
        btnSavePostsCSV.className = "btn btn-sm btn-outline-secondary text-start";
        btnSavePostsCSV.innerHTML = '<i class="fa-solid fa-file-csv me-2"></i>Save Class Posts as CSV (spreadsheet)';
        btnSavePostsCSV.addEventListener("click", () => runFileExport(btnSavePostsCSV, exportClassPostsCSV));
        actionsWrap.appendChild(btnSavePostsCSV);

        const btnSaveNotificationsMarkdown = document.createElement("button");
        btnSaveNotificationsMarkdown.type = "button";
        btnSaveNotificationsMarkdown.className = "btn btn-sm btn-outline-secondary text-start";
        btnSaveNotificationsMarkdown.innerHTML = '<i class="fa-solid fa-file-export me-2"></i>Save Notifications as Markdown for archival';
        btnSaveNotificationsMarkdown.addEventListener("click", () => runFileExport(btnSaveNotificationsMarkdown, exportNotificationsMarkdown));
        actionsWrap.appendChild(btnSaveNotificationsMarkdown);

        const btnSaveDataJSON = document.createElement("button");
        btnSaveDataJSON.type = "button";
        btnSaveDataJSON.className = "btn btn-sm btn-outline-secondary text-start";
        btnSaveDataJSON.innerHTML = '<i class="fa-solid fa-file-code me-2"></i>Export my data as JSON (unified by post_id)';
        btnSaveDataJSON.addEventListener("click", () => runFileExport(btnSaveDataJSON, exportDataJSON));
        actionsWrap.appendChild(btnSaveDataJSON);

        actionsWrap.appendChild(createFetchStudentButton());

        body.appendChild(actionsWrap);

        const links = [
            { text: "My Website", href: "https://kurtlvc.github.io/", icon: "fa-globe" },
            { text: "GitHub Profile", href: "https://github.com/kurtlvc", icon: "fa-user" },
        ];
        const list = document.createElement("div");
        list.className = "list-group";
        links.forEach((l) => {
            const a = document.createElement("a");
            a.className = "list-group-item list-group-item-action";
            a.href = l.href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.innerHTML = `<i class="fa-solid ${l.icon} me-2"></i>${l.text}`;
            list.appendChild(a);
        });
        body.appendChild(list);

        return {
            id: "enhancerMenuModal",
            title: "PinnaCle Enhanced",
            icon: "fa-fire",
            content: body,
        };
    }

    async function runFileExport(button, exportFn) {
        const original = button.innerHTML;
        button.disabled = true;
        button.textContent = "Preparing…";
        const progress = { collected: 0, total: 0, failed: 0, retries: 0 };

        const renderProgress = (status = "Saving…") => {
            const total = progress.total || "?";
            button.textContent = `${status} ${progress.collected}/${total} posts · ${progress.failed} partially collected · ${progress.retries} retries`;
        };

        try {
            await exportFn((update = {}) => {
                Object.assign(progress, update);
                renderProgress(update.status || "Saving…");
            });
        } catch (err) {
            console.error("PinnaCle Enhanced: markdown export failed:", err);
            showToast("Export failed: " + err.message, "error");
        } finally {
            button.disabled = false;
            button.innerHTML = original;
        }
    }

    function downloadTextFile(filename, text, mimeType = "text/markdown;charset=utf-8") {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // Rebuilds one markdown file covering every enrolled class's posts.
    //
    // FIXED (was broken): this used to read file/link fields that don't
    // exist on the real objects (f.name/f.file_name/f.url, l.link/l.name),
    // so every attachment silently fell back to the literal string
    // "attachment" or showed no clickable destination. It also only ever
    // pulled attachments from fetchAttachmentsByPostId(), which — per the
    // CONFIRMED GAP note above fetchAttachmentsByPostId — only covers
    // Material-type posts; every Test/Assignment/Announcement/Online Class
    // post was exported with an empty attachment list even when it had
    // files or links, because the per-post backfill fetch (fetchPostAttachments)
    // was only ever wired into the on-screen cards (buildClassPost), never
    // into this export path. Both are fixed below: real field names are
    // used, video attachments are included, and non-Material posts get the
    // same per-post backfill fetch the UI cards use before the markdown is
    // built (using a local copy of the attachment map so this export
    // doesn't mutate the shared/persisted attachments cache).
    // Shared by exportClassPostsMarkdown and exportClassPostsCSV: fetches
    // every class's posts plus their attachments, backfilling non-Material
    // posts one PostPage at a time (same per-post fetch the on-screen cards
    // use). Both export formats need identical data, so the network +
    // progress-reporting logic only lives here once.
    async function collectClassPostsForExport(onProgress = () => { }) {
        const schedules = getPath(pinnacle, "props.schedules", null);
        if (!schedules || !Array.isArray(schedules) || schedules.length === 0) {
            showToast("No class schedule data on this page — visit the Dashboard first.", "error");
            return null;
        }

        const items = schedules.map((c) => ({
            id: c.class_no,
            title: `${c.course.code} - ${c.course.description}`,
            section: c.blocking.block.block_name,
        }));

        // Class pages are still fetched using the existing cached/batched path.
        // The expensive Student/PostPage backfill below is deliberately
        // sequential, because firing every post-detail request at once can
        // trigger a burst of HTTP 429 responses.
        const [postsByIndex, attachmentsByPostId] = await Promise.all([
            fetchClassPostsCached(items),
            fetchAttachmentsByPostId(),
        ]);

        const exportAttachments = new Map(attachmentsByPostId);
        const postJobs = [];

        postsByIndex.forEach((posts, i) => {
            if (!posts) return;
            const classId = items[i].id;
            posts.forEach((p) => {
                if (p.type_id === MATERIAL_TYPE_ID) return;
                if (exportAttachments.has(p.post_id)) return;
                postJobs.push({
                    classId,
                    urlKey: p.url_key,
                    postId: p.post_id,
                });
            });
        });

        const totalPostPages = postJobs.length;
        let collected = 0;
        let failed = 0;
        let retries = 0;

        onProgress({ collected, total: totalPostPages, failed, retries, status: "Saving…" });

        for (let i = 0; i < postJobs.length; i++) {
            const job = postJobs[i];
            let data = null;

            try {
                data = await requestWithRetry(
                    () => fetchInertiaPage(`/student/class/${job.classId}/post/${job.urlKey}`),
                    {
                        maxRetries: 4,
                        baseDelayMs: 800,
                        onRetry: () => {
                            retries++;
                            onProgress({ collected, total: totalPostPages, failed, retries, status: "Retrying…" });
                        },
                    },
                );

                exportAttachments.set(job.postId, {
                    files: getPath(data, "props.files", []),
                    links: getPath(data, "props.links", []),
                    videos: [],
                    submission: getPath(data, "props.submission", null),
                });
                collected++;
            } catch (err) {
                failed++;
                console.warn(`PinnaCle Enhanced: failed to export PostPage ${job.postId}:`, err);
                // Keep an empty entry so this post is still exported instead
                // of causing the entire export to abort.
                exportAttachments.set(job.postId, { files: [], links: [], videos: [], submission: null });
            }

            onProgress({
                collected,
                total: totalPostPages,
                failed,
                retries,
                status: i + 1 === totalPostPages ? "Finalizing…" : "Saving…",
            });

            // Small intentional gap between PostPage requests.  This is in
            // addition to the global request limiter and helps avoid a burst
            // pattern when a class contains many posts.
            if (i + 1 < postJobs.length) {
                await sleep(350 + Math.random() * 300);
            }
        }

        return {
            items,
            postsByIndex,
            exportAttachments,
            stats: { collected, total: totalPostPages, failed, retries },
        };
    }

    function reportExportDone(onProgress, stats) {
        onProgress({ ...stats, status: "Complete" });
        showToast(
            stats.failed > 0
                ? `Class posts exported with ${stats.failed} failed PostPage request${stats.failed === 1 ? "" : "s"} (${stats.retries} retries).`
                : `Class posts exported (${stats.collected} PostPage request${stats.collected === 1 ? "" : "s"}, ${stats.retries} retries).`,
            stats.failed > 0 ? "warning" : "success",
            5000,
        );
    }

    async function exportClassPostsMarkdown(onProgress = () => { }) {
        const result = await collectClassPostsForExport(onProgress);
        if (!result) return;
        const { items, postsByIndex, exportAttachments, stats } = result;

        const lines = [`# Class Posts — exported ${new Date().toLocaleString()}`, ""];

        items.forEach((it, i) => {
            lines.push(`## ${it.title} (${it.section})`, "");
            const posts = postsByIndex[i];
            if (!posts) {
                lines.push("_Details unavailable._", "");
                return;
            }
            if (posts.length === 0) {
                lines.push("_No posts._", "");
                return;
            }
            posts
                .map((p) => mapPostToCardProps(p, it.id, exportAttachments))
                .forEach((p) => {
                    lines.push(`#### **${p.title}**${p.dueDate ? ` — due ${p.dueDate}${p.isPastDue ? ` (past due - ${p.postedTime || "n/a"})` : ""}` : ""}`);
                    if (p.subtitle) lines.push(`  - Type: ${p.subtitle}`);
                    if (p.postDate) lines.push(`  - Posted: ${p.postDate}`);
                    if (p.dueDate) lines.push(`  - Due: ${p.dueDate}`);
                    if (p.author) lines.push(`  - Posted by: ${p.author}`);
                    if (p.description) lines.push(`  - ${p.description.replace(/\s+/g, " ").trim()}`);
                    if (p.href) lines.push(`  - Post URL: https://pinnacle.pnc.edu.ph${p.href}`);
                    (p.files || []).forEach((f) => {
                        const href = f.view_link || f.preview_link || f.uc_link || "";
                        const label = f.orig_filename || f.filename || "Attachment";
                        lines.push(href ? `  - 📎 File: [${label}](${href})` : `  - 📎 File: ${label}`);
                    });
                    (p.links || []).forEach((l) => {
                        const label = l.title || l.url || "link";
                        lines.push(l.url ? `  - 🔗 Link: [${label}](${l.url})` : `  - 🔗 Link: ${label}`);
                    });
                    (p.videos || []).forEach((v, idx) => {
                        const href = v.url || v.video_url || v.link || v.embed_url || v.watch_url || "";
                        const label = v.title || v.name || v.filename || `Video ${idx + 1}`;
                        lines.push(href ? `  - 🎬 Video: [${label}](${href})` : `  - 🎬 Video: ${label}`);
                    });
                    lines.push("");
                });
        });

        downloadTextFile(`pinnacle-class-posts-${Date.now()}.md`, lines.join("\n"));
        reportExportDone(onProgress, stats);
    }

    // Escapes one CSV field per RFC 4180: wrap in quotes and double any
    // internal quotes, but only when the value actually needs it (contains
    // a comma, quote, or line break) — keeps plain values readable un-quoted.
    function csvField(value) {
        const str = value === null || value === undefined ? "" : String(value);
        if (/[",\r\n]/.test(str)) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    }

    function csvRow(values) {
        return values.map(csvField).join(",") + "\r\n";
    }

    // Formats one post's files/links/videos for a single CSV cell as
    // "label (url) | label (url) | ...". Takes the same label/href
    // fallback chains buildClassPost's buildAttachmentChip() uses for the
    // on-screen cards, so the export always agrees with what a post
    // actually looks like in the UI.
    function formatAttachmentsForCSV(items, labelFn, hrefFn) {
        return (items || [])
            .map((item, idx) => {
                const label = labelFn(item, idx);
                const href = hrefFn(item, idx);
                return href ? `${label} (${href})` : label;
            })
            .join(" | ");
    }

    // Same underlying data as the markdown export, laid out as one row per
    // post instead — meant for opening in Excel/Sheets/Numbers or feeding
    // into another tool, rather than for reading top-to-bottom.
    async function exportClassPostsCSV(onProgress = () => { }) {
        const result = await collectClassPostsForExport(onProgress);
        if (!result) return;
        const { items, postsByIndex, exportAttachments, stats } = result;

        const header = [
            "Class", "Section", "Type", "Title", "Posted", "Due Date",
            "Past Due", "Posted By", "Description", "Post URL",
            "Files (label + URL)", "Links (label + URL)", "Videos (label + URL)",
        ];
        let csv = csvRow(header);

        items.forEach((it, i) => {
            const posts = postsByIndex[i];
            if (!posts || posts.length === 0) return;

            posts
                .map((p) => mapPostToCardProps(p, it.id, exportAttachments))
                .forEach((p) => {
                    // Multiple attachments of the same kind share one cell, as
                    // "label (url) | label (url)" — a dedicated "Attachments"
                    // sheet would need a join table, and most spreadsheet
                    // tools let you search/click a URL inside a cell fine.
                    // Same href fallback order as the on-screen post cards
                    // (buildAttachmentChip), so this always matches the UI.
                    const files = formatAttachmentsForCSV(
                        p.files,
                        (f) => f.orig_filename || f.filename || "Attachment",
                        (f) => f.view_link || f.preview_link || f.uc_link || "",
                    );
                    const links = formatAttachmentsForCSV(
                        p.links,
                        (l) => l.title || l.url || "link",
                        (l) => l.url || "",
                    );
                    const videos = formatAttachmentsForCSV(
                        p.videos,
                        (v, idx) => v.title || v.name || v.filename || `Video ${idx + 1}`,
                        (v) => v.url || v.video_url || v.link || v.embed_url || v.watch_url || "",
                    );

                    csv += csvRow([
                        it.title,
                        it.section,
                        p.subtitle || "",
                        p.title || "",
                        p.postDate || "",
                        p.dueDate || "",
                        p.dueDate ? (p.isPastDue ? "Yes" : "No") : "",
                        p.author || "",
                        (p.description || "").replace(/\s+/g, " ").trim(),
                        p.href ? `https://pinnacle.pnc.edu.ph${p.href}` : "",
                        files,
                        links,
                        videos,
                    ]);
                });
        });

        // Leading BOM so Excel (which guesses ANSI otherwise) opens this as
        // UTF-8 without mangling emoji/ñ/₱ characters in titles and names.
        downloadTextFile(`pinnacle-class-posts-${Date.now()}.csv`, "\uFEFF" + csv, "text/csv;charset=utf-8");
        reportExportDone(onProgress, stats);
    }

    // Unified JSON export. Every post is one record keyed by post_id, joined with:
    //   - its class (sched_id / class_no)
    //   - teacher attachments (references for Material; props.post.files/links/videos
    //     from Student/PostPage for everything else)
    //   - the student's own uploads + submission (props.files / props.links / props.submission)
    //   - the matching notification (notification.id === post_id)
    async function exportDataJSON(onProgress = () => { }) {
        const schedules = getPath(pinnacle, "props.schedules", null);
        if (!Array.isArray(schedules) || schedules.length === 0) {
            showToast("No class schedule data on this page — visit the Dashboard first.", "error");
            return;
        }

        const includeFullProfile = confirm(
            "Include your FULL personal profile (birthdate, address, parents, emergency contacts, LRN)?\n\n" +
            "OK = full profile\nCancel = basic info only (recommended if you'll share this file)"
        );

        const errors = [];
        let collected = 0, failed = 0, retries = 0;

        // ---- Student ----
        const s = getPath(pinnacle, "props.student", {}) || {};
        const student = includeFullProfile ? s : {
            stud_id: s.stud_id, ref_no: s.ref_no, lname: s.lname, fname: s.fname, mname: s.mname,
            emailaddress: s.emailaddress, year_id: s.year_id, is_regular: s.is_regular,
        };

        // ---- Classes + posts ----
        const items = schedules.map((c) => ({
            id: c.class_no,
            title: `${c.course.code} - ${c.course.description}`,
            section: c.blocking.block.block_name,
        }));

        onProgress({ collected, total: 0, failed, retries, status: "Loading classes…" });
        const [postsByIndex, referenceAttachments] = await Promise.all([
            fetchClassPostsCached(items),
            fetchAttachmentsByPostId(),
        ]);

        const postsById = {};
        const classes = [];
        const jobs = [];

        schedules.forEach((sched, i) => {
            const posts = postsByIndex[i];
            const teachers = [...new Set(
                (sched.daytimes || []).flatMap((d) => (d.pf_loads || []).map((l) => l.plotting_form?.faculty?.fullname)).filter(Boolean)
            )];

            classes.push({
                sched_id: sched.sched_id,
                class_no: sched.class_no,
                course: {
                    code: sched.course.code,
                    description: sched.course.description,
                    units: sched.course.units,
                },
                section: sched.blocking.block.block_name,
                schedule: sched.formatted_dtr,
                teachers,
                posts_unavailable: posts === null,
                post_ids: posts ? posts.map((p) => p.post_id) : [],
            });

            if (!posts) {
                errors.push({ scope: "class", class_no: sched.class_no, error: "class posts could not be loaded" });
                return;
            }

            posts.forEach((p) => {
                const ref = referenceAttachments.get(p.post_id);
                postsById[p.post_id] = {
                    ...p,
                    class_no: sched.class_no,
                    attachments: {
                        source: ref ? "references" : "none",
                        files: ref?.files || [],
                        links: ref?.links || [],
                        videos: [],
                    },
                    student_uploads: { files: [], links: [] },
                    submission: null,
                    notification: null,
                    fetch_error: null,
                };
                if (p.type_id !== MATERIAL_TYPE_ID) {
                    jobs.push({ classId: sched.class_no, urlKey: p.url_key, postId: p.post_id });
                }
            });
        });

        // ---- Per-post PostPage backfill (sequential, same pacing as the other exports) ----
        onProgress({ collected, total: jobs.length, failed, retries, status: "Saving…" });

        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            const rec = postsById[job.postId];
            try {
                const page = await requestWithRetry(
                    () => fetchInertiaPage(`/student/class/${job.classId}/post/${job.urlKey}`),
                    {
                        maxRetries: 4,
                        baseDelayMs: 800,
                        onRetry: () => {
                            retries++;
                            onProgress({ collected, total: jobs.length, failed, retries, status: "Retrying…" });
                        },
                    },
                );
                // Teacher's attachments live on props.post.*; props.files/links are the STUDENT's uploads.
                rec.attachments = {
                    source: "post_page",
                    files: getPath(page, "props.post.files", []),
                    links: getPath(page, "props.post.links", []),
                    videos: getPath(page, "props.post.videos", []),
                };
                rec.student_uploads = {
                    files: getPath(page, "props.files", []),
                    links: getPath(page, "props.links", []),
                };
                rec.submission = getPath(page, "props.submission", null);
                collected++;
            } catch (err) {
                failed++;
                rec.fetch_error = err.message;
                errors.push({ scope: "post", post_id: job.postId, class_no: job.classId, error: err.message });
            }
            onProgress({ collected, total: jobs.length, failed, retries, status: i + 1 === jobs.length ? "Finalizing…" : "Saving…" });
            if (i + 1 < jobs.length) await sleep(350 + Math.random() * 300);
        }

        // ---- Notifications (id === post_id) ----
        const orphanNotifications = [];
        try {
            let nPage = pinnacle;
            if (!String(getPath(nPage, "component", "")).startsWith("Student/Notification")) {
                nPage = await requestWithRetry(() => fetchInertiaPage("/student/notifications"));
            }
            const notifications = getPath(nPage, "props.notifications", []);
            (Array.isArray(notifications) ? notifications : []).forEach((n) => {
                if (postsById[n.id]) postsById[n.id].notification = n;
                else orphanNotifications.push(n);
            });
        } catch (err) {
            errors.push({ scope: "notifications", error: err.message });
        }

        // ---- Announcements (only on Student/Dashboard, so fetch it if we're elsewhere) ----
        const announcements = {};
        try {
            let dPage = pinnacle;
            if (getPath(dPage, "component", "") !== "Student/Dashboard") {
                dPage = await requestWithRetry(() => fetchInertiaPage("/student"));
            }
            const ann = getPath(dPage, "props.announcements", []);
            (Array.isArray(ann) ? ann : []).forEach((a) => {
                announcements[a.ann_id] = a;
            });
        } catch (err) {
            errors.push({ scope: "announcements", error: err.message });
        }

        // ---- Schedules (full raw objects, keyed by sched_id) ----
        // `schedules` already exists at the top of this function, so I reuse it
        // instead of declaring `schd`.
        const schedulesById = {};
        schedules.forEach((sched) => {
            // /student/references embeds files/links on each schedule. They are already
            // in posts[].attachments, so strip them to avoid a huge duplicate payload.
            const { files, links, ...rest } = sched;
            schedulesById[sched.sched_id] = rest;
        });

        const out = {
            meta: {
                exported_at: new Date().toISOString(),
                script_version: "1.10.0",
                pinnacle_version: getPath(pinnacle, "version", null),
                semester: getPath(pinnacle, "props.setting.semester", null),
                academic_year: getPath(pinnacle, "props.setting.acad_year.ay_name", null),
                full_profile_included: includeFullProfile,
                counts: {
                    classes: classes.length,
                    posts: Object.keys(postsById).length,
                    post_pages_fetched: collected,
                    post_pages_failed: failed,
                    announcements: Object.keys(announcements).length,   // new
                    schedules: Object.keys(schedulesById).length,       // new
                    orphan_notifications: orphanNotifications.length,
                },
                errors,
            },
            student,
            classes,
            posts: postsById,
            announcements,
            schedules: schedulesById,
            orphan_notifications: orphanNotifications,
        };

        downloadTextFile(`pinnacle-data-${Date.now()}.json`, JSON.stringify(out, null, 2), "application/json;charset=utf-8");
        onProgress({ collected, total: jobs.length, failed, retries, status: "Complete" });
        showToast(
            failed ? `Data exported with ${failed} failed request(s) — see meta.errors.` : "Data exported.",
            failed ? "error" : "success",
            5000,
        );
    }


    // Export of the Notifications page's data.
    //
    // CONFIRMED SHAPE (as of 2026-09, from a live payload): a notification
    // is NOT a title+body pair — it's a single ready-made sentence in
    // `message` (e.g. "Arcelito Quiatchon posted a new Assignment:
    // Individual Assessment #1 - Finals."), plus:
    //   id        — this IS the post_id (matches post_id used elsewhere,
    //               e.g. the /student/class/work/submit payload)
    //   url       — full absolute link straight to the post
    //   datetime  — full timestamp, e.g. "2026-09-08 11:51:46"
    //   timestamp — short display form, e.g. "Sep 8"
    //   seen      — 1 / 0
    // There is no separate title/subject/header field, which is exactly
    // why the old guess-based version showed "(untitled) — Sep 8": it was
    // matching `n.timestamp` (the short date) while `n.title` etc. never
    // existed. `message` is used as the heading now. The raw-JSON fallback
    // stays in place for any shape that doesn't match this one — e.g. if
    // the site adds other notification kinds later.
    async function exportNotificationsMarkdown() {
        let page = pinnacle;
        if (getPath(page, "component", null) !== "Student/Notifications") {
            page = await requestWithRetry(() => fetchInertiaPage("/student/notifications"));
        }

        const notifications =
            getPath(page, "props.notifications", null) ||
            getPath(page, "props.notification_list", null) ||
            getPath(page, "props.items", null) ||
            getPath(page, "props.notifs", null);

        if (!notifications || !Array.isArray(notifications) || notifications.length === 0) {
            showToast("No notifications found to export.", "error");
            return;
        }

        const lines = [`# Notifications — exported ${new Date().toLocaleString()}`, ""];
        notifications.forEach((n) => {
            const message = n.message || n.title || n.subject || n.header || null;
            const when = n.datetime || n.timestamp || n.created_at || n.date || n.posted || null;
            const url = n.url || null;
            const unread = n.seen === 0;

            if (message) {
                lines.push(`## ${message}${when ? ` — ${when}` : ""}${unread ? " 🔵 unread" : ""}`, "");
                if (url) lines.push(`[Open post](${url})`, "");
            } else {
                // Doesn't match the confirmed shape above — dump raw data
                // rather than guessing at more field names.
                lines.push("### (unrecognized notification shape — raw data below)", "");
                lines.push("```json", JSON.stringify(n, null, 2), "```", "");
            }
        });

        downloadTextFile(`pinnacle-notifications-${Date.now()}.md`, lines.join("\n"));
        showToast("Notifications exported.", "success", 3000);
    }

    function customButton({
        id = null,
        title = "",
        faIcon = "fa-gear",
        className = "btn btn-outline-success border-0 px-2 ms-1",
        width = null,
        onClick = null,
    } = {}) {
        const button = document.createElement("button");
        button.type = "button";
        if (id) button.id = id;
        button.title = title;
        button.className = className;
        if (width) button.style.width = width;

        const icon = document.createElement("i");
        icon.className = `fa-solid ${faIcon}`;
        button.appendChild(icon);

        if (typeof onClick === "function") button.addEventListener("click", onClick);
        return button;
    }

    function customNavButton({
        text = "Button",
        id = null,
        link = null,
        icon = "fa-gear",
        className = "btn btn-outline-success border-0 d-block text-start fw-bold py-1",
        iconPosition = "left",
        onClick = null,
        target = null,
        dataAttributes = {},
        activeClass = null,
        disabled = false,
    } = {}) {
        const li = document.createElement("li");
        li.className = "nav-item";
        if (id) li.id = `nav-${id}`;

        const linkElement = document.createElement("a");
        linkElement.className = className;
        if (disabled) {
            linkElement.classList.add("disabled");
            linkElement.setAttribute("aria-disabled", "true");
        }
        if (link) {
            linkElement.href = link;
            if (target) linkElement.target = target;
        } else {
            linkElement.setAttribute("role", "button");
        }
        if (activeClass) linkElement.classList.add(activeClass);

        Object.entries(dataAttributes).forEach(([key, value]) => {
            linkElement.setAttribute(`data-${key}`, value);
        });

        const iconElement = document.createElement("i");
        iconElement.className = `fa-solid fa-fw ${icon} me-2`;
        const textNode = document.createTextNode(text);

        if (iconPosition === "right") {
            linkElement.append(textNode, iconElement);
        } else {
            linkElement.append(iconElement, textNode);
        }

        if (typeof onClick === "function") linkElement.addEventListener("click", onClick);
        li.appendChild(linkElement);
        return li;
    }

    // Shared modal lifecycle: Bootstrap when available, otherwise a complete
    // fallback that wires every dismiss button, backdrop clicks, Escape, and
    // body scroll cleanup. This keeps custom gradebook dialogs closable even
    // on pages where Bootstrap's Modal plugin is not exposed to the userscript.
    function showCustomModal(modal) {
        if (!modal) return;
        if (window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modal).show();
            modal.addEventListener("hidden.bs.modal", () => {
                window.bootstrap?.Modal?.getInstance(modal)?.dispose();
                modal.remove();
            }, { once: true });
            return;
        }

        modal.dataset.peFallbackModal = "true";
        modal.classList.add("show", "d-block");
        modal.style.display = "block";
        modal.style.background = "rgba(0,0,0,.35)";
        modal.setAttribute("aria-modal", "true");
        modal.setAttribute("role", "dialog");
        document.body.classList.add("modal-open");

        const backdrop = document.createElement("div");
        backdrop.className = "modal-backdrop fade show pe-fallback-modal-backdrop";
        backdrop.dataset.peModalFor = modal.id;
        document.body.appendChild(backdrop);

        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            modal.classList.remove("show", "d-block");
            modal.style.display = "none";
            modal.removeAttribute("aria-modal");
            backdrop.remove();
            modal.remove();
            if (!document.querySelector('.modal.show, .modal.d-block')) {
                document.body.classList.remove("modal-open");
                document.querySelectorAll(".pe-fallback-modal-backdrop").forEach((el) => el.remove());
            }
            document.removeEventListener("keydown", onKeyDown, true);
        };
        const onKeyDown = (event) => {
            if (event.key === "Escape" && modal.getAttribute("data-bs-keyboard") !== "false") {
                event.preventDefault();
                close();
            }
        };
        modal.querySelectorAll("[data-bs-dismiss='modal']").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                close();
            });
        });
        backdrop.addEventListener("click", () => {
            if (modal.getAttribute("data-bs-backdrop") !== "static") close();
        });
        document.addEventListener("keydown", onKeyDown, true);
        modal._peCloseModal = close;
    }

    function hideCustomModal(modal) {
        if (!modal) return;
        if (typeof modal._peCloseModal === "function") {
            modal._peCloseModal();
            return;
        }
        if (window.bootstrap?.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modal).hide();
            return;
        }
        modal.remove();
        if (!document.querySelector('.modal.show, .modal.d-block')) {
            document.body.classList.remove("modal-open");
            document.querySelectorAll(".pe-fallback-modal-backdrop").forEach((el) => el.remove());
        }
    }

    function customModal({
        id = "customModal",
        title = "Modal Title",
        icon = "fa-info-circle",
        content = "",
        footerButtons = [{ label: "Close", variant: "secondary", dismiss: true }],
        size = "modal-lg",
        scrollable = true,
        backdrop = "static",
        keyboard = false,
    } = {}) {
        const modal = document.createElement("div");
        modal.className = "modal fade";
        modal.id = id;
        modal.setAttribute("tabindex", "-1");
        modal.setAttribute("aria-labelledby", `${id}Label`);
        modal.setAttribute("aria-hidden", "true");
        modal.setAttribute("data-bs-backdrop", backdrop);
        modal.setAttribute("data-bs-keyboard", keyboard);

        const modalDialog = document.createElement("div");
        const dialogClasses = ["modal-dialog", size];
        if (scrollable) dialogClasses.push("modal-dialog-scrollable");
        modalDialog.className = dialogClasses.join(" ");

        const modalContent = document.createElement("div");
        modalContent.className = "modal-content";

        const modalHeader = document.createElement("div");
        modalHeader.className = "modal-header text-bg-success";

        const modalTitle = document.createElement("h5");
        modalTitle.className = "modal-title";
        modalTitle.id = `${id}Label`;
        if (icon) {
            const titleIcon = document.createElement("i");
            titleIcon.className = `fa-solid ${icon} me-2`;
            modalTitle.appendChild(titleIcon);
        }
        modalTitle.appendChild(document.createTextNode(title));

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.className = "btn-close btn-close-white";
        closeBtn.setAttribute("data-bs-dismiss", "modal");
        closeBtn.setAttribute("aria-label", "Close");

        modalHeader.append(modalTitle, closeBtn);

        const modalBody = document.createElement("div");
        modalBody.className = "modal-body bg-body-tertiary p-4";
        if (typeof content === "string") modalBody.innerHTML = content;
        else if (content instanceof HTMLElement) modalBody.appendChild(content);

        const modalFooter = document.createElement("div");
        modalFooter.className = "modal-footer py-0";
        footerButtons.forEach((btn) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `btn`;
            button.textContent = btn.label;
            if (btn.dismiss) button.setAttribute("data-bs-dismiss", "modal");
            if (typeof btn.onClick === "function") {
                button.addEventListener("click", btn.onClick);
            }
            modalFooter.appendChild(button);
        });

        modalContent.append(modalHeader, modalBody, modalFooter);
        modalDialog.appendChild(modalContent);
        modal.appendChild(modalDialog);
        return modal;
    }

    // --- macOS-style loading screen --------------------------------------
    // Built entirely with DOM calls. Reads the "macLoadScreen" setting on
    // every navigation, so toggling it in Enhancer Settings takes effect
    // right after Save with no reload.
    //
    // pointer-events:none is deliberate: this script already strips the
    // site's own .screen-blocker (see clearScreenBlocker) so the page stays
    // usable during loads. The overlay is visual only and never blocks clicks.
    const macLoad = (function () {
        const ROOT_SELECTOR = "#app";
        const STYLE_ID = "pe-macload-styles";
        const SHOW_DELAY_MS = 150; // skip the overlay on fast navigations
        const FADE_MS = 250;       // keep in sync with the CSS transition
        const SPOKES = 12;

        let overlay = null;
        let fill = null;
        let showTimer = null;
        let hideTimer = null;

        function injectStyles() {
            if (document.getElementById(STYLE_ID)) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = [
                ".pe-macload{--pe-ink:#3c3c43;--pe-track:rgba(60,60,67,.18);",
                "  position:fixed;inset:0;z-index:9999;display:grid;place-items:center;pointer-events:none;",
                "  background:rgba(246,246,246,.72);",
                "  -webkit-backdrop-filter:blur(0px) saturate(180%);backdrop-filter:blur(0px) saturate(180%);",
                "  font:13px -apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif;",
                "  opacity:0;transition:opacity " + FADE_MS + "ms ease}",
                ".pe-macload.is-visible{opacity:1}",
                "@media (prefers-color-scheme:dark){",
                "  .pe-macload{--pe-ink:#ebebf5;--pe-track:rgba(235,235,245,.22);background:rgba(30,30,30,.72)}}",
                ".pe-macload__stack{display:flex;flex-direction:column;align-items:center;gap:22px}",
                ".pe-macload__spinner{position:relative;width:32px;height:32px}",
                ".pe-macload__spoke{position:absolute;left:50%;top:0;width:2.5px;height:8px;margin-left:-1.25px;",
                "  border-radius:2px;background:var(--pe-ink);transform-origin:50% 16px;",
                "  transform:rotate(var(--r));opacity:.15;animation:pe-macload-spoke 1s linear infinite;",
                "  animation-delay:var(--d)}",
                "@keyframes pe-macload-spoke{from{opacity:1}to{opacity:.15}}",
                ".pe-macload__track{width:150px;height:4px;border-radius:2px;background:var(--pe-track);overflow:hidden}",
                ".pe-macload__fill{width:100%;height:100%;border-radius:2px;background:var(--pe-ink);",
                "  transform-origin:left center;transform:scaleX(0);transition:transform .3s ease}",
                ".pe-macload__fill.is-indeterminate{width:40%;transform:none;transition:none;",
                "  animation:pe-macload-slide 1.2s ease-in-out infinite}",
                "@keyframes pe-macload-slide{from{margin-left:-40%}to{margin-left:100%}}",
                "@media (prefers-reduced-motion:reduce){",
                "  .pe-macload{transition:none}",
                "  .pe-macload__spoke{animation-duration:2.4s}",
                "  .pe-macload__fill.is-indeterminate{animation:none;width:100%;opacity:.5}}",
            ].join("\n");
            document.head.appendChild(style);
        }

        function build() {
            const el = document.createElement("div");
            el.className = "pe-macload";
            el.setAttribute("role", "status");
            el.setAttribute("aria-live", "polite");
            el.setAttribute("aria-label", "Loading");

            const stack = document.createElement("div");
            stack.className = "pe-macload__stack";

            const spinner = document.createElement("div");
            spinner.className = "pe-macload__spinner";
            for (let i = 0; i < SPOKES; i++) {
                const spoke = document.createElement("span");
                spoke.className = "pe-macload__spoke";
                spoke.style.setProperty("--r", (i * 360 / SPOKES) + "deg");
                spoke.style.setProperty("--d", ((i / SPOKES) - 1).toFixed(3) + "s");
                spinner.appendChild(spoke);
            }

            const track = document.createElement("div");
            track.className = "pe-macload__track";
            fill = document.createElement("div");
            fill.className = "pe-macload__fill is-indeterminate";
            track.appendChild(fill);

            stack.append(spinner, track);
            el.appendChild(stack);
            return el;
        }

        function mount() {
            const root = document.querySelector(ROOT_SELECTOR);
            if (!root) return;
            injectStyles();
            overlay = build();
            root.appendChild(overlay);
            void overlay.offsetWidth; // force reflow so the fade-in runs
            overlay.classList.add("is-visible");
        }

        function show(delay) {
            if (!loadUISettings().macLoadScreen) return;
            clearTimeout(hideTimer);
            clearTimeout(showTimer);

            // The framework can drop our node from #app; never trust a stale reference.
            if (overlay && !overlay.isConnected) { overlay = null; fill = null; }

            if (overlay) {
                overlay.classList.add("is-visible"); // was fading out
                return;
            }
            showTimer = setTimeout(mount, delay === undefined ? SHOW_DELAY_MS : delay);
        }

        function hide() {
            clearTimeout(showTimer); // navigation finished before the delay elapsed
            if (!overlay) return;

            const el = overlay;
            el.classList.remove("is-visible");
            hideTimer = setTimeout(() => {
                el.remove();
                if (overlay === el) { overlay = null; fill = null; }
            }, FADE_MS);
        }

        function progress(percentage) {
            if (!fill || typeof percentage !== "number") return;
            fill.classList.remove("is-indeterminate");
            fill.style.transform = "scaleX(" + Math.max(0, Math.min(percentage, 100)) / 100 + ")";
        }

        return { show, hide, progress };
    })();

    // --- Remote theme (CSS) -----------------------------------------------
    // Downloads a stylesheet with GM_xmlhttpRequest and injects it as a
    // <style> tag. It has to be fetched (not linked with <link rel=stylesheet>):
    // raw.githubusercontent.com serves files as text/plain with nosniff, and
    // browsers refuse to apply a stylesheet with the wrong MIME type. Fetching
    // through the userscript manager also sidesteps the page's CSP/CORS rules.
    //
    // Persistence: the CSS text is cached with GM_setValue. Every page load
    // injects the cached copy synchronously (instant, works offline) and then
    // revalidates in the background once it is older than THEME_TTL_MS.
    const THEME_CACHE_KEY = "pinnacle_enhanced_theme_cache";
    const THEME_STYLE_ID = "pe-remote-theme";
    const THEME_TTL_MS = 6 * 60 * 60 * 1000;
    const THEME_MAX_CHARS = 512 * 1024;

    // Add more entries here and they show up in the Settings dropdown.
    const THEMES = [
        {
            id: "seqo",
            label: "Seqo (macOS Sequoia)",
            url: "https://raw.githubusercontent.com/kurtlvc/Pinnacle-CSS-tweaks/refs/heads/main/css/pncseqo.css",
        },
    ];

    const remoteTheme = (function () {
        let syncToken = 0; // lets a newer sync() cancel an older one that's still downloading

        function readCache() {
            try { return GM_getValue(THEME_CACHE_KEY, null); } catch (_) { return null; }
        }

        function writeCache(entry) {
            try { GM_setValue(THEME_CACHE_KEY, entry); } catch (err) {
                console.warn("PinnaCle Enhanced: failed to cache theme:", err);
            }
        }

        function inject(css) {
            let el = document.getElementById(THEME_STYLE_ID);
            if (!el) {
                el = document.createElement("style");
                el.id = THEME_STYLE_ID;
            }
            el.textContent = css;
            // Appending (or re-appending) puts it last, so it wins ties against
            // the site's own stylesheets and this script's UI styles.
            (document.head || document.documentElement).appendChild(el);
        }

        function remove() {
            document.getElementById(THEME_STYLE_ID)?.remove();
        }

        function fetchCss(url) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: "GET",
                    url,
                    timeout: 15000,
                    anonymous: true, // no cookies to GitHub
                    headers: { Accept: "text/css,*/*;q=0.1" },
                    onload: (res) => {
                        const text = res.responseText || "";
                        if (res.status !== 200) reject(new Error("HTTP " + res.status));
                        else if (!text.trim()) reject(new Error("the file is empty"));
                        else if (text.length > THEME_MAX_CHARS) reject(new Error("the file is unexpectedly large"));
                        else if (/^\s*</.test(text)) reject(new Error("got HTML instead of CSS"));
                        else resolve(text);
                    },
                    onerror: () => reject(new Error("network error")),
                    ontimeout: () => reject(new Error("request timed out")),
                });
            });
        }

        async function sync(themeId, { force = false, notify = false } = {}) {
            const token = ++syncToken;
            const theme = THEMES.find((t) => t.id === themeId);

            if (!theme) { // "none", or an id that no longer exists in THEMES
                remove();
                return;
            }

            const cached = readCache();
            const usable = !!cached && cached.id === theme.id && cached.url === theme.url && typeof cached.css === "string";

            if (usable) inject(cached.css); // instant, and still works if GitHub is unreachable
            else remove();                  // switching themes: drop the old one while the new one loads

            if (usable && !force && Date.now() - cached.fetchedAt < THEME_TTL_MS) return;

            try {
                const css = await fetchCss(theme.url);
                if (token !== syncToken) return; // selection changed while downloading
                const changed = !usable || css !== cached.css;
                writeCache({ id: theme.id, url: theme.url, css, fetchedAt: Date.now() });
                if (changed) {
                    inject(css);
                    if (notify) showToast(`Theme "${theme.label}" applied.`, "success", 3000);
                }
            } catch (err) {
                console.warn("PinnaCle Enhanced: theme download failed:", err);
                if (notify && token === syncToken) {
                    showToast(`Couldn't download the theme: ${err.message}.` + (usable ? " Using the saved copy." : ""), "error");
                }
            }
        }

        return { sync };
    })();

    injectUIGlobalStyles();
    applyUISettings(loadUISettings());
    remoteTheme.sync(loadUISettings().themeId);

    const CACHE_SCHEMA_VERSION = "v4";

    function persistedCacheKey(name) {
        return `pinnacle_enhanced_${CACHE_SCHEMA_VERSION}_${name}`;
    }

    function loadPersistedCache(name, ttlMs) {
        try {
            const raw = GM_getValue(persistedCacheKey(name), null);
            if (!raw || typeof raw !== "object" || typeof raw.timestamp !== "number") return null;
            if (Date.now() - raw.timestamp > ttlMs) return null;
            return raw;
        } catch (err) {
            console.warn(`PinnaCle Enhanced: failed to read persisted cache "${name}":`, err);
            return null;
        }
    }

    function savePersistedCache(name, payload) {
        try {
            GM_setValue(persistedCacheKey(name), { timestamp: Date.now(), ...payload });
        } catch (err) {
            console.warn(`PinnaCle Enhanced: failed to write persisted cache "${name}":`, err);
        }
    }

    function clearAllPinnacleCaches() {
        pendingTasksCache = { key: null, timestamp: 0, data: null };
        attachmentsCache = { timestamp: 0, data: null };
        postAttachmentsCache.clear();

        try {
            const prefix = persistedCacheKey("");
            const keys = GM_listValues().filter((k) => k.startsWith(prefix));
            keys.forEach((k) => GM_deleteValue(k));
            console.log(`PinnaCle Enhanced: cleared ${keys.length} persisted cache entr${keys.length === 1 ? "y" : "ies"}.`);
        } catch (err) {
            console.warn("PinnaCle Enhanced: failed to clear persisted caches:", err);
        }
    }

    let renderPageHandlersTimer = null;
    function schedulePageHandlers(page, source) {
        console.log(`PinnaCle Enhanced: ${source} → page render scheduled`);
        if (renderPageHandlersTimer) {
            clearTimeout(renderPageHandlersTimer);
        }
        renderPageHandlersTimer = setTimeout(() => {
            renderPageHandlersTimer = null;
            handlePage(page);
            componentHandler(page);
            versionTracker(page);
            pendingTaskManager(page, page.props?.schedules ?? []);
            settingsUIManager(page);
        }, 0);
    }

    let navStartedAt = null;

    document.addEventListener('inertia:success', (event) => {
        console.log(event.type);
        if (navStartedAt !== null) {
            updateTimingBadge(performance.now() - navStartedAt);
            navStartedAt = null;
        }
        schedulePageHandlers(event.detail.page, 'success');
    });

    document.addEventListener('inertia:before', (event) => {
        console.log(event.type);
    });

    document.addEventListener('inertia:start', (event) => {
        console.log(event.type);
        navStartedAt = performance.now();
        macLoad.show();
    });

    document.addEventListener('inertia:progress', (event) => {
        console.log(event.type);
        macLoad.progress(event.detail?.progress?.percentage);
    });

    document.addEventListener('inertia:finish', (event) => {
        console.log(event.type);
        macLoad.hide();
    });

    document.addEventListener('inertia:navigate', (event) => {
        console.log(event.type);
        schedulePageHandlers(event.detail.page, 'navigate');
    });

    document.addEventListener('inertia:error', (event) => {
        console.log(event.type);
        macLoad.hide(); // safety net so a failed visit never leaves the overlay up
    });

    document.addEventListener('inertia:invalid', (event) => {
        console.log(event.type);
        macLoad.hide(); // safety net so a failed visit never leaves the overlay up
    });

    document.addEventListener('inertia:exception', (event) => {
        console.log(event.type);
        macLoad.hide(); // safety net so a failed visit never leaves the overlay up
    });

    function handlePage(page) {
        if (!validatePageData(page)) {
            return;
        }

        pinnacle = page;
        console.log(page.component, page.props);

    }

    function componentHandler(page) {
        switch (page.component) {
            case 'Student/Dashboard':
                dashboardHandler(page);
                break;
            case 'Student/Notifications':
                notificationsHandler(page);
                break;
            case 'Student/ClassPage':
                classPageHandler(page);
                break;
            case 'Student/PostPage':
                postPageHandler(page);
                break;
            default:
                console.log("No handler for " + page.component);
        }
    }

    function dashboardHandler(page) {
        if (page.component == 'Student/Dashboard') {
            debugCard();
            classesManager(page);
        }
    }

    function classPageHandler(page) {
        classPageManager(page);
    }

    function classPageManager(page) {
        // Prevent DOM duplication on soft refreshes
        if (document.getElementById("btnGradeBook")) return;

        // Gracefully attempt to get class data from the Inertia page props
        const classInfo = page.props?.class || page.props?.detail || page.props?.course || {};
        const courseCode = document.querySelector("#app > div.d-flex > main > div > div > div.col-xxl-9.col-xl-8.mb-5 > div.card.card-body.shadow-sm.text-light.p-4.mb-4 > div.text-center > h3 > b").innerText.split(":")[0] || classInfo.code || getPath(page, "props.course.code", "Course");
        const courseDesc = document.querySelector("#app > div.d-flex > main > div > div > div.col-xxl-9.col-xl-8.mb-5 > div.card.card-body.shadow-sm.text-light.p-4.mb-4 > div.text-center > h6 > b").innerText || classInfo.description || getPath(page, "props.course.description", "Gradebook");
        const classId = window.location.pathname.split("/")[3] || classInfo.class_no || getPath(page, "props.class_no") || getPath(page, "props.detail.class_no");

        const rowElement = document.querySelector("#app > div.d-flex > main > div > div > div.col-xxl-9.col-xl-8.mb-5 > div.row") ||
            document.querySelector(".col-xxl-9 .row");

        if (!rowElement) {
            console.warn("PinnaCle Enhanced: No elements to create into.");
            return;
        }

        if (rowElement.firstChild && rowElement.firstChild.nodeType === Node.ELEMENT_NODE) {
            rowElement.firstChild.className = 'col-lg-4';
        }

        const newDiv = document.createElement('div');
        newDiv.className = 'col-lg-4';

        const btnGradeBook = document.createElement("button");
        btnGradeBook.id = "btnGradeBook";
        btnGradeBook.className = "btn btn-outline-secondary w-100";
        btnGradeBook.innerHTML = '<i class="fa-solid fa-book"></i> View Gradebook';

        btnGradeBook.addEventListener("click", () => {
            openGradebookModal(page, classId, courseCode, courseDesc);
        });

        newDiv.appendChild(btnGradeBook);
        rowElement.appendChild(newDiv);
    }

    function openGradebookModal(page, classId, courseCode, courseDesc) {
        // Compact gradebook: each assignment mirrors the concise horizontal
        // information hierarchy of the LMS list (title/deadline on the left,
        // grade or submission state on the right). The post detail fetch is
        // shared with buildClassPost through fetchPostAttachments(), so files,
        // links, videos, and submission grades all come from the same payload/cache.
        const content = document.createElement("div");
        content.className = "pe-gradebook-list";

        const controls = document.createElement("div");
        controls.className = "d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3";

        const filterWrap = document.createElement("div");
        filterWrap.className = "d-flex align-items-center gap-2";
        const filterLabel = document.createElement("label");
        filterLabel.className = "small fw-semibold text-muted mb-0";
        filterLabel.textContent = "Show:";
        const filterSelect = document.createElement("select");
        filterSelect.className = "form-select form-select-sm w-auto";
        ["All", "Submitted", "Graded", "Not Submitted"].forEach((value) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            filterSelect.appendChild(option);
        });
        filterWrap.append(filterLabel, filterSelect);

        const termWrap = document.createElement("div");
        termWrap.className = "d-flex align-items-center gap-2";
        const termLabel = document.createElement("label");
        termLabel.className = "small fw-semibold text-muted mb-0";
        termLabel.textContent = "Term:";
        const termSelect = document.createElement("select");
        termSelect.className = "form-select form-select-sm w-auto";
        [
            { value: "All Terms", label: "All Terms" },
            { value: "Prelim", label: "Prelim" },
            { value: "Midterm", label: "Midterm" },
            { value: "Finals", label: "Finals" },
        ].forEach(({ value, label }) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            termSelect.appendChild(option);
        });
        termWrap.append(termLabel, termSelect);

        const summary = document.createElement("small");
        summary.className = "text-muted";
        summary.textContent = "Loading gradebook…";
        controls.append(filterWrap, termWrap, summary);
        content.appendChild(controls);

        const list = document.createElement("div");
        list.className = "d-flex flex-column gap-2";
        content.appendChild(list);

        const posts = getPath(page, "props.posts", []);
        const gradePosts = posts
            .filter((post) => Number(post.type_id) === ONLINETEST_TYPE_ID || Number(post.type_id) === ASSIGNMENT_TYPE_ID)
            .slice()
            .sort((a, b) => {
                const termOrder = { "Prelim": 1, "Midterm": 2, "Finals": 3, "Pre-Fi": 3 };
                const termDiff = (termOrder[a.term] || 99) - (termOrder[b.term] || 99);
                return termDiff || (new Date(a.dtl_deadline || 0) - new Date(b.dtl_deadline || 0));
            });

        const cardRecords = [];
        const escapeText = (value) => String(value ?? "");
        const normalizeTerm = (value) => {
            const term = String(value ?? "").trim().toLowerCase();
            if (term === "prelim" || term.startsWith("prelim")) return "Prelim";
            if (term === "midterm" || term.startsWith("midterm")) return "Midterm";
            if (term === "finals" || term === "final" || term === "pre-fi" || term.startsWith("final")) return "Finals";
            return value ? String(value).trim() : "No term";
        };

        function createAttachmentModal(post, data) {
            const attachmentContent = document.createElement("div");
            // Student/PostPage exposes the post's attachments as props.files
            // and props.links. Do not read props.post.files/links or props.videos.
            const groups = [
                { label: "Files", icon: "fa-folder-open", items: data.files || [], getTitle: (item) => item.orig_filename || item.filename || "Attachment", getHref: (item) => item.view_link || item.preview_link || item.uc_link },
                { label: "Links", icon: "fa-link", items: data.links || [], getTitle: (item) => item.title || item.url || "Link", getHref: (item) => item.url },
            ];
            let total = 0;
            groups.forEach((group) => {
                const validItems = group.items.filter((item) => group.getHref(item));
                if (!validItems.length) return;
                total += validItems.length;
                const heading = document.createElement("h6");
                heading.className = "mt-3 mb-2";
                const icon = document.createElement("i");
                icon.className = `fa-solid ${group.icon} me-2`;
                heading.append(icon, document.createTextNode(group.label));
                attachmentContent.appendChild(heading);
                const itemList = document.createElement("div");
                itemList.className = "list-group";
                validItems.forEach((item) => {
                    const link = document.createElement("a");
                    link.className = "list-group-item list-group-item-action d-flex align-items-center gap-2";
                    link.href = group.getHref(item);
                    link.target = "_blank";
                    link.rel = "noopener noreferrer";
                    const linkIcon = document.createElement("i");
                    linkIcon.className = `fa-solid ${group.icon} text-muted`;
                    const label = document.createElement("span");
                    label.className = "text-break";
                    label.textContent = group.getTitle(item);
                    link.append(linkIcon, label);
                    itemList.appendChild(link);
                });
                attachmentContent.appendChild(itemList);
            });
            if (!total) {
                const empty = document.createElement("p");
                empty.className = "text-muted mb-0";
                empty.textContent = "No files or links were found for this post.";
                attachmentContent.appendChild(empty);
            }
            const attachmentModal = customModal({
                id: `gradebookAttachments-${String(post.post_id).replace(/[^a-z0-9_-]/gi, "")}`,
                title: `Attachments · ${post.title || "Post"}`,
                icon: "fa-paperclip",
                content: attachmentContent,
                size: "modal-md",
                backdrop: "true",
                keyboard: true,
            });
            // IDs are unique per post, but remove any stale copy if the user
            // opens the attachment dialog repeatedly before it is cleaned up.
            document.getElementById(attachmentModal.id)?.remove();
            document.body.appendChild(attachmentModal);
            showCustomModal(attachmentModal);
        }

        function makeCard(post) {
            const typeMeta = POST_TYPE_META[post.type_id] || { label: "Work", icon: "📝" };
            const card = document.createElement("div");
            card.className = "card shadow-sm pe-gradebook-card";
            card.style.cssText = "border:1px solid var(--bs-border-color);border-radius:.65rem;transition:border-color .15s,box-shadow .15s;";

            const body = document.createElement("div");
            body.className = "card-body py-2 px-3";
            const row = document.createElement("div");
            row.className = "d-flex align-items-center gap-3";

            const main = document.createElement("div");
            main.className = "flex-grow-1 min-w-0";
            const titleLine = document.createElement("div");
            titleLine.className = "d-flex align-items-center flex-wrap gap-2";
            const title = document.createElement("a");
            title.className = "fw-semibold text-reset text-decoration-none";
            title.href = `/student/class/${encodeURIComponent(classId)}/post/${encodeURIComponent(post.url_key || "")}`;
            title.textContent = `${typeMeta.icon} ${escapeText(post.title || "Untitled post")}`;
            title.addEventListener("click", (event) => {
                // Use Inertia's router hook for same-tab navigation instead of
                // opening a raw browser tab or bypassing the SPA lifecycle.
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                const destination = title.href;
                hideCustomModal(document.getElementById("gradebookModal"));
                if (!inertiaVisit(destination)) window.location.assign(destination);
            });
            titleLine.appendChild(title);
            const subline = document.createElement("div");
            subline.className = "small text-muted mt-1 d-flex flex-wrap align-items-center gap-2";
            const term = document.createElement("span");
            term.className = "fw-normal";
            term.textContent = `${normalizeTerm(post.term)} ${typeMeta.label}`;
            subline.appendChild(term);
            if (post.due) {
                const due = document.createElement("span");
                due.textContent = `· Due ${post.due}`;
                subline.appendChild(due);
            }
            const attachmentButton = document.createElement("button");
            attachmentButton.type = "button";
            attachmentButton.className = "btn btn-sm btn-link text-secondary text-decoration-none p-0 d-none";
            attachmentButton.innerHTML = '<i class="fa-solid fa-paperclip me-1"></i><span>0</span>';
            attachmentButton.title = "View attachments (files and links)";
            attachmentButton.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (record.data) createAttachmentModal(post, record.data);
            });
            subline.appendChild(attachmentButton);
            main.append(titleLine, subline);

            const result = document.createElement("div");
            result.className = "text-end flex-shrink-0";
            result.style.minWidth = "94px";
            const grade = document.createElement("div");
            grade.className = "fw-semibold";
            grade.textContent = Number(post.status) === 1 ? "Submitted" : "Not submitted";
            const detail = document.createElement("small");
            detail.className = "text-muted d-block";
            detail.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-label="Loading"></i> Loading';
            result.append(grade, detail);
            row.append(main, result);
            body.appendChild(row);
            card.appendChild(body);

            const record = { post, card, grade, detail, attachmentButton, data: null, submitted: Number(post.status) === 1, graded: false };
            cardRecords.push(record);

            if (!classId || !post.url_key || post.post_id == null) {
                detail.textContent = "Grade unavailable";
            } else {
                fetchPostAttachments(classId, post.url_key, post.post_id).then((data) => {
                    record.data = data || { files: [], links: [], submission: null };
                    const submission = record.data.submission;
                    const filesCount = (record.data.files?.length || 0) + (record.data.links?.length || 0);
                    if (filesCount) {
                        attachmentButton.querySelector("span").textContent = String(filesCount);
                        attachmentButton.classList.remove("d-none");
                    }
                    if (submission && submission.score !== null && submission.score !== undefined) {
                        record.graded = true;
                        grade.textContent = `${submission.score} / ${submission.hps ?? "?"}`;
                        grade.className = "fw-bold text-success";
                        detail.textContent = submission.submit_date ? `Submitted · ${submission.submit_date}` : "Graded";
                    } else if (record.submitted || submission) {
                        record.submitted = true;
                        grade.textContent = "Submitted";
                        grade.className = "fw-semibold text-success";
                        detail.textContent = submission?.submit_date ? `Submitted · ${submission.submit_date}` : "Awaiting grade";
                    } else {
                        grade.textContent = "Not submitted";
                        grade.className = "fw-semibold text-secondary";
                        detail.textContent = "No submission";
                    }
                    applyFilter();
                }).catch((error) => {
                    console.warn(`PinnaCle Enhanced: gradebook detail fetch failed for post ${post.post_id}:`, error);
                    detail.textContent = "Could not load grade";
                });
            }
            return card;
        }

        function applyFilter() {
            const filter = filterSelect.value;
            const selectedTerm = termSelect.value;
            let shown = 0;
            cardRecords.forEach((record) => {
                const matchesStatus = filter === "All" ||
                    (filter === "Submitted" && record.submitted) ||
                    (filter === "Not Submitted" && !record.submitted) ||
                    (filter === "Graded" && record.graded);
                const matchesTerm = selectedTerm === "All Terms" || normalizeTerm(record.post.term) === selectedTerm;
                const matches = matchesStatus && matchesTerm;
                record.card.classList.toggle("d-none", !matches);
                if (matches) shown++;
            });
            summary.textContent = `${shown} of ${cardRecords.length} posts`;
            let empty = list.querySelector(".pe-gradebook-empty");
            if (!shown) {
                if (!empty) {
                    empty = document.createElement("div");
                    empty.className = "pe-gradebook-empty text-center text-muted py-4";
                    empty.textContent = "No posts match this filter.";
                    list.appendChild(empty);
                }
            } else {
                empty?.remove();
            }
        }

        filterSelect.addEventListener("change", applyFilter);
        termSelect.addEventListener("change", applyFilter);
        if (!gradePosts.length) {
            const empty = document.createElement("div");
            empty.className = "text-center text-muted py-4";
            empty.textContent = "No online tests or assignments were found for this class.";
            list.appendChild(empty);
            summary.textContent = "0 posts";
        } else {
            gradePosts.forEach((post) => list.appendChild(makeCard(post)));
            applyFilter();
        }

        const modal = customModal({
            id: "gradebookModal",
            title: `Gradebook · ${courseCode} - ${courseDesc}`,
            icon: "fa-book",
            content,
            size: "modal-lg",
            backdrop: "true",
            keyboard: true,
        });
        document.getElementById("gradebookModal")?.remove();
        document.body.appendChild(modal);
        showCustomModal(modal);
    }

    function postPageHandler(page) {
        postPageManager(page);
    }

    function postPageManager(page) {
        // Prevent button duplication
        if (document.getElementById("btnSavePostPng")) return;

        const rowElement = document.querySelector("#app > div.d-flex > main > div.container-fluid > div > div.col-xxl-9.col-xl-8.mb-5 > div.row") ||
            document.querySelector(".col-xxl-9 .row");

        if (!rowElement) {
            console.warn("PinnaCle Enhanced: No elements to modify.");
            return;
        }

        if (rowElement.firstChild && rowElement.firstChild.nodeType === Node.ELEMENT_NODE) {
            rowElement.firstChild.className = 'col-lg-4';
        }

        const newDiv = document.createElement('div');
        newDiv.className = 'col-lg-4';

        const btnSavePostPng = document.createElement("button");
        btnSavePostPng.id = "btnSavePostPng";
        btnSavePostPng.className = "btn btn-outline-secondary w-100";
        btnSavePostPng.innerHTML = '<i class="fa-solid fa-camera"></i> Save as PNG';

        btnSavePostPng.addEventListener("click", async () => {
            const originalText = btnSavePostPng.innerHTML;
            btnSavePostPng.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
            btnSavePostPng.disabled = true;

            try {
                // The page and userscript can have separate JavaScript globals.
                // Read html2canvas from the page context and verify that it is callable;
                // a truthy but non-function window.html2canvas caused the prior failure.
                const pageWindow = (typeof unsafeWindow !== "undefined" && unsafeWindow) ? unsafeWindow : window;
                if (typeof pageWindow.html2canvas !== "function") {
                    await new Promise((resolve, reject) => {
                        const existingScript = document.querySelector('script[data-pe-html2canvas="true"]');
                        if (existingScript?.dataset.loaded === "true") {
                            resolve();
                            return;
                        }
                        if (existingScript?.dataset.loading === "true") {
                            existingScript.addEventListener("load", resolve, { once: true });
                            existingScript.addEventListener("error", reject, { once: true });
                            return;
                        }
                        // Remove a failed/stale script element so a later click can retry.
                        existingScript?.remove();
                        const script = document.createElement("script");
                        script.dataset.peHtml2canvas = "true";
                        script.dataset.loading = "true";
                        script.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
                        script.onload = () => {
                            script.dataset.loaded = "true";
                            script.dataset.loading = "false";
                            resolve();
                        };
                        script.onerror = () => {
                            script.dataset.loading = "false";
                            script.remove();
                            reject(new Error("Could not load html2canvas. Check the network or content blocker."));
                        };
                        document.head.appendChild(script);
                    });
                }
                if (typeof pageWindow.html2canvas !== "function") {
                    throw new Error("html2canvas loaded, but its function is unavailable in the page context. Reload Pinnacle and try again.");
                }

                // Instead of relying on fragile node indexes (childNodes[2], etc), we target
                // the entire post wrapper so the visual output retains its styling and padding.
                const postContainer = document.querySelector("#app > div.d-flex > main > div.container-fluid > div > div.col-xxl-9.col-xl-8.mb-5") ||
                    document.querySelector(".col-xxl-9");

                if (!postContainer) throw new Error("Could not find the post container.");

                // Render the canvas
                const canvas = await pageWindow.html2canvas(postContainer, {
                    useCORS: true,
                    scale: 2, // High resolution output
                    backgroundColor: document.documentElement.classList.contains("dark") ? "#1e1e1e" : "#f6f6f6"
                });

                // Trigger Download
                const link = document.createElement("a");
                const postTitle = getPath(page, "props.post.title", "Post");
                const sanitizedTitle = postTitle.replace(/[^a-z0-9]/gi, '_');

                link.download = `PinnaCle_${sanitizedTitle}.png`;
                link.href = canvas.toDataURL("image/png");
                link.click();

                showToast("Post saved successfully!", "success", 3000);

            } catch (err) {
                console.error("PinnaCle Enhanced: Failed to capture PNG", err);
                showToast("Failed to save PNG: " + err.message, "error", 5000);
            } finally {
                btnSavePostPng.innerHTML = originalText;
                btnSavePostPng.disabled = false;
            }
        });

        newDiv.appendChild(btnSavePostPng);
        rowElement.appendChild(newDiv);
    }

    function pendingTaskManager(page, schedules) {
        const pendingTaskModal = document.querySelector("#tasksModal");
        if (!pendingTaskModal) {
            console.warn("PinnaCle Enhanced: Pending Task Modal not found yet.");
            return;
        }

        pendingTaskModal._enhancedSchedules = schedules;

        const badge = ensurePendingTaskBadge();

        if (pendingTaskModal.dataset.enhancedWired !== "true") {
            pendingTaskModal.dataset.enhancedWired = "true";

            pendingTaskModal.addEventListener("show.bs.modal", () => {
                const liveBadge = document.querySelector(".pending-task-badge");
                if (liveBadge) {
                    liveBadge.dataset.enhancedModalOpen = "true";
                    liveBadge.classList.add("d-none");
                }
                renderPendingTasks(pendingTaskModal, pendingTaskModal._enhancedSchedules || [])
                    .then(() => {
                        if (liveBadge) setPendingTaskBadgeCount(liveBadge, pendingTasksCache.data?.length ?? 0);
                    });
            });

            pendingTaskModal.addEventListener("hidden.bs.modal", () => {
                const liveBadge = document.querySelector(".pending-task-badge");
                if (liveBadge) {
                    delete liveBadge.dataset.enhancedModalOpen;
                    liveBadge.classList.toggle("d-none", Number(liveBadge.dataset.enhancedCount || "0") === 0);
                }
            });
        }

        if (badge && schedules && schedules.length > 0) {
            refreshPendingTaskBadge(schedules);
        }
    }

    function ensurePendingTaskBadge() {
        const existing = document.querySelector(".pending-task-badge");
        if (existing) return existing;

        const button = document.querySelector(
            "#app > div.d-flex > aside > div > ul > li:nth-child(2) > button"
        );
        if (!button) {
            console.warn("PinnaCle Enhanced: Pending Tasks nav button not found, skipping badge.");
            return null;
        }

        const badge = document.createElement("span");
        badge.className = "badge bg-danger rounded-pill ms-2 pending-task-badge d-none";
        badge.textContent = "0";
        badge.dataset.enhancedCount = "0";
        button.appendChild(badge);
        return badge;
    }

    function setPendingTaskBadgeCount(badge, count) {
        badge.textContent = String(count);
        badge.dataset.enhancedCount = String(count);
        if (badge.dataset.enhancedModalOpen !== "true") {
            badge.classList.toggle("d-none", count === 0);
        }
    }

    function revalidatePendingTasks(cacheKey, schedules) {
        if (!pendingTasksRefreshInFlight) {
            pendingTasksRefreshInFlight = (async () => {
                try {
                    const tasks = await fetchPendingTasks(schedules);
                    pendingTasksCache = { key: cacheKey, timestamp: Date.now(), data: tasks };
                    return tasks;
                } finally {
                    pendingTasksRefreshInFlight = null;
                }
            })();
        }
        return pendingTasksRefreshInFlight;
    }

    async function refreshPendingTaskBadge(schedules) {
        const badge = document.querySelector(".pending-task-badge");
        if (!badge) return;

        const cacheKey = schedules.map((c) => c.class_no).sort().join(",");
        const now = Date.now();
        const sameClasses = pendingTasksCache.key === cacheKey && pendingTasksCache.data;
        const cacheIsFresh = sameClasses
            && (now - pendingTasksCache.timestamp) < PENDING_TASKS_TTL_MS;

        if (cacheIsFresh) {
            setPendingTaskBadgeCount(badge, pendingTasksCache.data.length);
            return;
        }

        if (sameClasses) {
            setPendingTaskBadgeCount(badge, pendingTasksCache.data.length);
        }

        try {
            const tasks = await revalidatePendingTasks(cacheKey, schedules);
            setPendingTaskBadgeCount(badge, tasks.length);
        } catch (err) {
            console.warn("PinnaCle Enhanced: failed to refresh pending-task badge:", err);
        }
    }

    function paintPendingTasks(pendingTaskBody, tasks) {
        pendingTaskBody.innerHTML = "";

        if (tasks.length === 0) {
            pendingTaskBody.innerHTML = '<small class="text-muted">No pending tasks. You\'re all caught up!</small>';
            return;
        }

        const frag = document.createDocumentFragment();
        tasks.forEach((t) => frag.appendChild(buildClassPost(t)));
        pendingTaskBody.appendChild(frag);
    }

    async function renderPendingTasks(modalEl, schedules) {
        const pendingTaskBody = modalEl.querySelector("div.modal-body");
        if (!pendingTaskBody) {
            console.warn("PinnaCle Enhanced: Pending Task modal body not found.");
            return;
        }

        const cacheKey = schedules.map((c) => c.class_no).sort().join(",");
        const now = Date.now();
        const sameClasses = pendingTasksCache.key === cacheKey && pendingTasksCache.data;
        const cacheIsFresh = sameClasses
            && (now - pendingTasksCache.timestamp) < PENDING_TASKS_TTL_MS;

        if (cacheIsFresh) {
            paintPendingTasks(pendingTaskBody, pendingTasksCache.data);
            return;
        }

        if (sameClasses) {
            paintPendingTasks(pendingTaskBody, pendingTasksCache.data);
            try {
                const tasks = await revalidatePendingTasks(cacheKey, schedules);
                if (document.body.contains(pendingTaskBody)) {
                    paintPendingTasks(pendingTaskBody, tasks);
                }
            } catch (err) {
                console.warn("PinnaCle Enhanced: failed to revalidate pending tasks, keeping stale list:", err);
            }
            return;
        }

        pendingTaskBody.innerHTML = "";
        pendingTaskBody.appendChild(loadingPendingTasksSkeleton());
        try {
            const tasks = await revalidatePendingTasks(cacheKey, schedules);
            paintPendingTasks(pendingTaskBody, tasks);
        } catch (err) {
            console.error("PinnaCle Enhanced: failed to build pending tasks:", err);
            pendingTaskBody.innerHTML = '<small class="text-danger">Could not load pending tasks.</small>';
        }
    }

    async function fetchAttachmentsByPostId() {
        const now = Date.now();
        if (attachmentsCache.data && (now - attachmentsCache.timestamp) < ATTACHMENTS_TTL_MS) {
            return attachmentsCache.data;
        }

        const persisted = loadPersistedCache("attachments", ATTACHMENTS_TTL_MS);
        if (persisted) {
            const map = new Map(persisted.entries);
            attachmentsCache = { timestamp: persisted.timestamp, data: map };
            return map;
        }

        try {
            const byPostId = new Map();
            const page = await requestWithRetry(() => fetchInertiaPage("/student/references"));
            const schedules = getPath(page, "props.schedules", []);

            const addAttachment = (kind, item) => {
                if (item.post_id == null) return;
                const entry = byPostId.get(item.post_id) || { files: [], links: [] };
                entry[kind].push(item);
                byPostId.set(item.post_id, entry);
            };

            schedules.forEach((sched) => {
                (sched.files || []).forEach((f) => addAttachment("files", f));
                (sched.links || []).forEach((l) => addAttachment("links", l));
            });

            attachmentsCache = { timestamp: now, data: byPostId };
            savePersistedCache("attachments", { entries: [...byPostId.entries()] });
            return byPostId;
        } catch (err) {
            console.warn("PinnaCle Enhanced: failed to load /student/references for attachments:", err);
            return attachmentsCache.data || new Map();
        }
    }

    async function fetchPostAttachments(classId, urlKey, postId) {
        const now = Date.now();

        const mem = postAttachmentsCache.get(postId);
        if (mem && (now - mem.timestamp) < POST_ATTACHMENTS_TTL_MS) {
            return mem.data;
        }

        const persisted = loadPersistedCache(`post_attachments_${postId}`, POST_ATTACHMENTS_TTL_MS);
        if (persisted) {
            postAttachmentsCache.set(postId, { timestamp: persisted.timestamp, data: persisted.data });
            return persisted.data;
        }

        try {
            const page = await requestWithRetry(() => fetchInertiaPage(`/student/class/${classId}/post/${urlKey}`));
            const data = {
                files: getPath(page, "props.files", []),
                links: getPath(page, "props.links", []),
                // Student/PostPage keeps student-uploaded files and links in
                // props.files / props.links. Do not use props.post.files/links.
                // null when the post hasn't been submitted (confirmed
                // against a live payload) — otherwise carries score, hps,
                // comment, submit_id, submit_date, etc. Reused by
                // buildClassPost to render the grade/submission-ID/comment
                // block once this resolves. Riding along on the same fetch
                // as files/links/videos above, so this doesn't cost an
                // extra request.
                submission: getPath(page, "props.submission", null),
            };

            postAttachmentsCache.set(postId, { timestamp: now, data });
            savePersistedCache(`post_attachments_${postId}`, { data });
            return data;
        } catch (err) {
            console.warn(`PinnaCle Enhanced: failed to load attachments for post ${postId}:`, err);
            return mem?.data || { files: [], links: [], submission: null };
        }
    }

    async function fetchClassPostsCachedSingle(item) {
        const persisted = loadPersistedCache(`class_posts_${item.id}`, CLASS_POSTS_TTL_MS);
        if (persisted) {
            return { posts: persisted.posts, stale: false };
        }

        try {
            const detail = await requestWithRetry(() => fetchInertiaPage(`/student/class/${item.id}`));
            const posts = getPath(detail, "props.posts", []);
            savePersistedCache(`class_posts_${item.id}`, { posts });
            return { posts, stale: false };
        } catch (err) {
            console.warn(`PinnaCle Enhanced: failed to load ${item.title} (/student/class/${item.id}):`, err);

            // Live fetch failed (offline, server hiccup, etc). Rather than
            // showing an empty card, fall back to whatever we last cached
            // for this class, even if it's past its normal TTL — stale
            // posts beat a broken-looking card. `Infinity` here just tells
            // loadPersistedCache to ignore the expiry check.
            const stale = loadPersistedCache(`class_posts_${item.id}`, Infinity);
            if (stale) {
                console.log(`PinnaCle Enhanced: using stale cached posts for "${item.title}" after fetch failure.`);
                return { posts: stale.posts, stale: true };
            }

            return { posts: null, stale: false };
        }
    }

    async function fetchClassPostsCached(items) {
        const postsByIndex = new Array(items.length);
        const toFetch = [];

        items.forEach((it, i) => {
            const persisted = loadPersistedCache(`class_posts_${it.id}`, CLASS_POSTS_TTL_MS);
            if (persisted) {
                postsByIndex[i] = persisted.posts;
            } else {
                toFetch.push({ item: it, index: i });
            }
        });

        if (toFetch.length > 0) {
            const urls = toFetch.map(({ item }) => `/student/class/${item.id}`);
            const fetched = await fetchInertiaPagesBatch(urls, { concurrency: 2 });

            fetched.forEach((detail, j) => {
                const { item, index } = toFetch[j];
                if (detail?.error) {
                    console.warn(`PinnaCle Enhanced: failed to load ${item.title} (${urls[j]}):`, detail.error);
                    postsByIndex[index] = null;
                    return;
                }

                const posts = getPath(detail, "props.posts", []);
                postsByIndex[index] = posts;
                savePersistedCache(`class_posts_${item.id}`, { posts });
            });
        }

        return postsByIndex;
    }

    async function fetchPendingTasks(schedules) {
        const items = schedules.map((c) => ({
            id: c.class_no,
            title: `${c.course.code} - ${c.course.description}`,
        }));

        const [postsByIndex, attachmentsByPostId] = await Promise.all([
            fetchClassPostsCached(items),
            fetchAttachmentsByPostId(),
        ]);

        const tasks = [];
        items.forEach((it, i) => {
            const posts = postsByIndex[i];
            if (posts === null) return;

            posts.forEach((p) => {
                const mapped = mapPostToCardProps(p, it.id, attachmentsByPostId);

                if (!mapped.dueDate || mapped.isPastDue) return;
                if (mapped.typeId === ASSIGNMENT_TYPE_ID && mapped.status === 1) return;

                mapped.subtitle = `${it.title} · ${mapped.subtitle}`;
                mapped.rawDeadline = p.dtl_deadline;
                tasks.push(mapped);
            });
        });

        tasks.sort((a, b) => new Date(a.rawDeadline) - new Date(b.rawDeadline));
        return tasks;
    }

    const POST_TYPE_META = {
        1: { label: "Online Test", icon: "📝" },
        2: { label: "Assignment", icon: "🎯" },
        3: { label: "Material", icon: "📁" },
        4: { label: "Announcement", icon: "📢" },
        5: { label: "Online Class", icon: "💻" },
    };

    const POSTS_PAGE_SIZE = 2;
    const ONLINETEST_TYPE_ID = 1;
    const ASSIGNMENT_TYPE_ID = 2;
    const MATERIAL_TYPE_ID = 3; // the only type /student/references actually covers — see CONFIRMED GAP note
    const ANNOUNCEMENT_TYPE_ID = 4;
    const ONLINECLASS_TYPE_ID = 5;

    async function classesManager(page) {
        const schedules = getPath(page, "props.schedules") || [];

        const items = schedules.map((c) => ({
            id: c.class_no,
            title: `${c.course.code} - ${c.course.description}`,
            section: c.blocking.block.block_name,
        }));

        const announcementsHeader = document.querySelector(
            "#app > div.d-flex > main > div.container-fluid > div > div.col-xxl-9.col-xl-8.mb-5 > h4"
        );
        if (!announcementsHeader) {
            console.warn("PinnaCle Enhanced: announcements header not found, skipping class cards.");
            return;
        }

        document.querySelectorAll(".classCard-instance, .classCard-loading").forEach((el) => el.remove());

        const loadingCardsMap = new Map();
        const loadingFrag = document.createDocumentFragment();

        items.forEach((it) => {
            const loadingCard = loadingClassCard(it.title, it.section);
            loadingCardsMap.set(it.id, loadingCard);
            loadingFrag.appendChild(loadingCard);
        });

        announcementsHeader.parentNode.insertBefore(loadingFrag, announcementsHeader);

        // References are shared by all cards, so load them once. Class posts,
        // however, are intentionally fetched/rendered one class at a time so
        // the first finished class appears immediately instead of waiting for
        // every class request to finish.
        const attachmentsByPostId = await fetchAttachmentsByPostId();

        // Set if any card ends up being filled from a stale (expired)
        // cache entry because its live fetch failed, so we can tell the
        // user once at the end instead of once per card.
        let usedStaleCache = false;

        for (const it of items) {
            const loadingCard = loadingCardsMap.get(it.id);

            if (!loadingCard || !loadingCard.isConnected) {
                continue;
            }

            const { posts, stale } = await fetchClassPostsCachedSingle(it);
            if (stale) usedStaleCache = true;

            // The loading placeholder is replaced as soon as this particular
            // class finishes. Other classes can keep their placeholders until
            // their own turn.
            const actualCard = buildClassCard(
                it.title,
                it.section,
                posts,
                it.id,
                attachmentsByPostId
            );

            if (loadingCard.isConnected) {
                loadingCard.replaceWith(actualCard);
            }
        }

        if (usedStaleCache) {
            showToast("Loaded cached posts, refresh to update", "success");
        }
    }

    function buildClassCard(classCode, section, posts, classId, attachmentsByPostId) {
        const newCard = document.createElement("div");
        newCard.className = "card card-body shadow-sm p-4 mb-4 classCard-instance";

        const state = {
            typeFilter: "all",
            // User-configurable (Settings → "Show past-due posts by default
            // on class cards"); defaults to hidden.
            showPastDue: !!loadUISettings().showPastDueByDefault,
            // User-configurable (Settings → "Show submitted works on
            // classmanager class cards"); defaults to hidden. Scoped to
            // Assignment/Online Test posts — the only types that carry a
            // meaningful submitted/graded status.
            showSubmitted: !!loadUISettings().showSubmittedWorkByDefault,
            expanded: false,
        };

        const allPosts = posts
            ? posts.map((p) => mapPostToCardProps(p, classId, attachmentsByPostId))
            : [];

        // "Submitted" = a graded-type post (Assignment or Online Test)
        // whose status is already 1 — same status value the header's
        // checkmark icon uses, and available synchronously from the
        // class-page posts list, so this filter (unlike the grade details
        // rendered in buildClassPost) doesn't need to wait on the per-post
        // detail fetch. Function-scoped (not inside the controls block
        // below) since render() also needs it.
        const isSubmittable = (p) => p.typeId === ASSIGNMENT_TYPE_ID || p.typeId === ONLINETEST_TYPE_ID;

        if (allPosts.length > 0) {
            const controls = document.createElement("div");
            controls.className = "d-flex align-items-center mb-2 gap-2 flex-wrap";

            const select = document.createElement("select");
            select.className = "form-select form-select-sm w-auto";

            const allOption = document.createElement("option");
            allOption.value = "all";
            allOption.textContent = "All types";
            select.appendChild(allOption);

            const typesPresent = [...new Set(allPosts.map((p) => p.typeId))];
            typesPresent.forEach((typeId) => {
                const opt = document.createElement("option");
                opt.value = String(typeId);
                const meta = POST_TYPE_META[typeId];
                opt.textContent = meta ? `${meta.icon} ${meta.label}` : `Type ${typeId}`;
                select.appendChild(opt);
            });

            // Default post type is user-configurable (Settings → "Default
            // post type shown in class cards"); falls back to "All types"
            // for a class that has none of the preferred type, rather than
            // showing an empty-looking card.
            const preferredRaw = loadUISettings().defaultPostTypeFilter;
            const preferredTypeFilter = preferredRaw === "all" ? "all" : Number(preferredRaw);
            state.typeFilter = (preferredTypeFilter === "all" || typesPresent.includes(preferredTypeFilter))
                ? preferredTypeFilter
                : "all";
            select.value = String(state.typeFilter);

            select.addEventListener("change", () => {
                state.typeFilter = select.value === "all" ? "all" : Number(select.value);
                state.expanded = false;
                render();
            });
            controls.appendChild(select);

            // Toggles live together on the right instead of being distributed
            // across the entire controls row.
            const toggleGroup = document.createElement("div");
            toggleGroup.className = "d-flex align-items-center gap-2 ms-auto flex-wrap";

            const pastDueCount = allPosts.filter((p) => p.isPastDue).length;
            if (pastDueCount > 0) {
                const pastDueBtn = document.createElement("button");
                pastDueBtn.type = "button";
                pastDueBtn.className = "btn btn-sm btn-outline-secondary";

                pastDueBtn.textContent = state.showPastDue
                    ? `Hide past due (${pastDueCount})`
                    : `Show past due (${pastDueCount})`;

                pastDueBtn.addEventListener("click", () => {
                    state.showPastDue = !state.showPastDue;

                    pastDueBtn.textContent = state.showPastDue
                        ? `Hide past due (${pastDueCount})`
                        : `Show past due (${pastDueCount})`;

                    state.expanded = false;
                    render();
                });
                toggleGroup.appendChild(pastDueBtn);
            }

            // "Submitted" filter/toggle uses isSubmittable (declared above,
            // function-scoped) for both this count and render()'s filter.
            const submittedCount = allPosts.filter((p) => isSubmittable(p) && p.status === 1).length;
            if (submittedCount > 0) {
                const submittedBtn = document.createElement("button");
                submittedBtn.type = "button";
                submittedBtn.className = "btn btn-sm btn-outline-secondary";

                submittedBtn.textContent = state.showSubmitted
                    ? `Hide submitted (${submittedCount})`
                    : `Show submitted (${submittedCount})`;

                submittedBtn.addEventListener("click", () => {
                    state.showSubmitted = !state.showSubmitted;

                    submittedBtn.textContent = state.showSubmitted
                        ? `Hide submitted (${submittedCount})`
                        : `Show submitted (${submittedCount})`;

                    state.expanded = false;
                    render();
                });
                toggleGroup.appendChild(submittedBtn);
            }

            controls.appendChild(toggleGroup);
            newCard.appendChild(controls);
        }

        const anchor = document.createElement("a");
        anchor.className = "text-decoration-none text-white";
        anchor.href = "/student/class/" + classId;
        // Plain <a> tags aren't wired into Inertia's router the way the
        // framework's own Link components are, so a click here would
        // otherwise fall through to a full browser navigation (page reload)
        // instead of the SPA transition the rest of the site uses. Hijack
        // the click the same way buildClassPost already does for post
        // cards: prevent the default navigation and hand the URL to
        // inertiaVisit(), which uses window.Inertia.visit() when available
        // and only falls back to a real navigation if that's not possible.
        anchor.addEventListener("click", (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            inertiaVisit(anchor.href);
        });
        const header = document.createElement("h5");
        const b = document.createElement("b");
        b.textContent = "📗 " + classCode + ": " + section;
        header.appendChild(b);
        anchor.appendChild(header);
        newCard.appendChild(anchor);

        const postsContainer = document.createElement("div");
        postsContainer.className = "mt-3";
        newCard.appendChild(postsContainer);

        const showMoreBtn = document.createElement("button");
        showMoreBtn.type = "button";
        showMoreBtn.className = "btn btn-sm btn-link d-none";
        showMoreBtn.addEventListener("click", () => {
            state.expanded = !state.expanded;
            render();
        });
        newCard.appendChild(showMoreBtn);

        function render() {
            postsContainer.innerHTML = "";

            if (posts === null) {
                const err = document.createElement("small");
                err.className = "text-danger";
                err.textContent = "Details unavailable";
                postsContainer.appendChild(err);
                return;
            }

            const filtered = allPosts.filter((p) => {
                if (state.typeFilter !== "all" && p.typeId !== state.typeFilter) return false;
                if (p.isPastDue && !state.showPastDue) return false;
                if (isSubmittable(p) && p.status === 1 && !state.showSubmitted) return false;
                return true;
            });

            if (filtered.length === 0) {
                const empty = document.createElement("small");
                empty.className = "text-muted";
                empty.textContent = "No posts to show.";
                postsContainer.appendChild(empty);
                showMoreBtn.classList.add("d-none");
                return;
            }

            const visible = state.expanded ? filtered : filtered.slice(0, POSTS_PAGE_SIZE);
            visible.forEach((p) => postsContainer.appendChild(buildClassPost(p)));

            if (filtered.length > POSTS_PAGE_SIZE) {
                showMoreBtn.classList.remove("d-none");
                showMoreBtn.textContent = state.expanded
                    ? "Show less"
                    : `Show more (${filtered.length - POSTS_PAGE_SIZE} more)`;
            } else {
                showMoreBtn.classList.add("d-none");
            }
        }

        render();
        return newCard;
    }

    function mapPostToCardProps(p, classId, attachmentsByPostId) {
        const { display: dueDate, isPastDue } = getDueStatus(p.due, p.dtl_deadline);
        const meta = POST_TYPE_META[p.type_id];
        const attachments = attachmentsByPostId?.get(p.post_id);

        return {
            href: `/student/class/${classId}/post/${p.url_key}`,
            title: p.title,
            subtitle: p.term ? `${p.term} ${p.type}` : p.type,
            icon: p.emoji || (meta ? meta.icon : "🎯"),
            description: p.details || p.truncated || "",
            dueDate,
            isPastDue,
            postDate: p.post_date || p.posted || null,
            postedTime: p.posted,
            author: p.faculty.fullname,
            status: p.status,
            typeId: p.type_id,
            files: attachments?.files || [],
            links: attachments?.links || [],
            videos: attachments?.videos || [],
            classId,
            urlKey: p.url_key,
            postId: p.post_id,
        };
    }

    function getDueStatus(due, dtlDeadline) {
        if (!due || !dtlDeadline) return { display: null, isPastDue: false };

        const parsed = new Date(dtlDeadline);
        if (isNaN(parsed.getTime())) {
            console.warn("PinnaCle Enhanced: could not parse dtl_deadline:", dtlDeadline);
            return { display: due, isPastDue: false };
        }

        return { display: due, isPastDue: parsed.getTime() < Date.now() };
    }

    function getPostStatusDisplay(status) {
        if (status === 1) {
            return { icon: "fa-solid fa-circle-check", title: "Work has been submitted", colorClass: "text-success" };
        }
        if (status === 3) {
            return { icon: "fa-solid fa-circle-exclamation", title: "Work needs attention", colorClass: "text-warning" };
        }
        return { icon: "fa-solid fa-ban", title: "Work has not been submitted", colorClass: "text-danger" };
    }

    function buildClassPost({
        href, title, subtitle = "Midterm Assignment", icon = "🎯",
        description, dueDate, isPastDue = false, postDate, postedTime, author, status, typeId,
        files = [], links = [], videos = [], classId, urlKey, postId
    }) {
        const card = document.createElement("a");
        card.href = href;
        card.className = "card card-body box-hover shadow-sm p-4 pb-4 mb-4 text-decoration-none text-reset";
        card.setAttribute("data-pe-post-card", "true");
        card.addEventListener("click", (e) => {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            inertiaVisit(href);
        });

        const header = document.createElement("div");
        header.className = "d-flex mb-1";

        const titleIcon = document.createElement("h1");
        titleIcon.className = "text-success mb-0 me-1";
        titleIcon.textContent = icon;

        const titleContainer = document.createElement("div");
        titleContainer.className = "ms-1 me-auto";

        const titleElement = document.createElement("h6");
        titleElement.className = "mb-0";

        const boldTitle = document.createElement("b");
        boldTitle.textContent = title;

        titleElement.appendChild(boldTitle);

        const subtitleElement = document.createElement("small");
        subtitleElement.className = "text-muted";
        subtitleElement.textContent = subtitle;

        titleContainer.append(titleElement, subtitleElement);

        const statusContainer = document.createElement("div");

        if (typeId === ASSIGNMENT_TYPE_ID) {
            const statusInfo = getPostStatusDisplay(status);

            const statusHeading = document.createElement("h2");
            statusHeading.className = statusInfo.colorClass;
            statusHeading.title = statusInfo.title;

            const statusIcon = document.createElement("i");
            statusIcon.className = statusInfo.icon;

            statusHeading.appendChild(statusIcon);
            statusContainer.appendChild(statusHeading);
        }

        header.append(titleIcon, titleContainer, statusContainer);

        const descriptionContainer = document.createElement("div");
        descriptionContainer.className = "mb-3 mx-1";

        const descriptionText = document.createElement("small");
        descriptionText.style.whiteSpace = "pre-line";
        descriptionText.textContent = description;

        descriptionContainer.appendChild(descriptionText);

        // Grade/submission details — populated lazily once the post's own
        // detail page resolves (see the fetchPostAttachments().then() call
        // below, which now also carries props.submission). Stays hidden
        // (d-none) for posts that were never submitted, since props.submission
        // is null in that case (confirmed against a live payload).
        const gradeContainer = document.createElement("div");
        gradeContainer.className = "mb-3 mx-1 d-none";

        const attachmentsContainer = document.createElement("div");
        attachmentsContainer.className = "mb-3 mx-1 d-flex flex-wrap gap-2 d-none";

        function buildAttachmentChip(attachHref, label, iconClass) {
            const chip = document.createElement("a");
            chip.href = attachHref;
            chip.target = "_blank";
            chip.rel = "noopener noreferrer";
            chip.title = label;
            chip.className = "badge text-bg-light text-decoration-none border d-inline-flex align-items-center gap-1";
            chip.addEventListener("click", (e) => e.stopPropagation());

            const chipIcon = document.createElement("i");
            chipIcon.className = iconClass;
            chip.appendChild(chipIcon);

            const chipLabel = document.createElement("span");
            chipLabel.className = "text-truncate d-inline-block";
            chipLabel.style.maxWidth = "180px";
            chipLabel.textContent = label;
            chip.appendChild(chipLabel);

            return chip;
        }

        function updateAttachmentsVisibility() {
            attachmentsContainer.classList.toggle("d-none", attachmentsContainer.childElementCount === 0);
        }

        const seenFileIds = new Set();
        const seenLinkIds = new Set();
        const seenVideoIds = new Set();

        function addFile(f) {
            const fileHref = f.view_link || f.preview_link || f.uc_link;
            if (!fileHref || seenFileIds.has(f.file_id)) return;
            seenFileIds.add(f.file_id);
            const label = f.orig_filename || f.filename || "Attachment";
            attachmentsContainer.appendChild(buildAttachmentChip(fileHref, label, "fa-solid fa-paperclip"));
        }

        function addLink(l) {
            if (!l.url || seenLinkIds.has(l.link_id)) return;
            seenLinkIds.add(l.link_id);
            const label = l.title || l.url;
            attachmentsContainer.appendChild(buildAttachmentChip(l.url, label, "fa-solid fa-link"));
        }

        function addVideo(v, index) {
            const videoHref = v.url || v.video_url || v.link || v.embed_url || v.watch_url;
            if (!videoHref) return;
            const key = v.video_id || v.id || videoHref;
            if (!seenVideoIds.has(key)) {
                seenVideoIds.add(key);
                const label = v.title || v.name || v.filename || `Video ${index + 1}`;
                attachmentsContainer.appendChild(
                    buildAttachmentChip(videoHref, label, "fa-solid fa-video")
                );
            }
        }

        files.forEach(addFile);
        links.forEach(addLink);
        videos.forEach(addVideo);
        updateAttachmentsVisibility();

        if (
            (typeId === ONLINETEST_TYPE_ID || typeId === ASSIGNMENT_TYPE_ID || typeId === ONLINECLASS_TYPE_ID || typeId === ANNOUNCEMENT_TYPE_ID)
            && classId != null && urlKey && postId != null
        ) {
            fetchPostAttachments(classId, urlKey, postId).then(({ files: postFiles, links: postLinks, videos: postVideos, submission }) => {
                postFiles.forEach(addFile);
                postLinks.forEach(addLink);
                (postVideos || []).forEach(addVideo);
                updateAttachmentsVisibility();

                // submission is null unless this post was actually
                // submitted — nothing to add beyond the header's status
                // icon in that case. dateContainer/updateDateContainerVisibility
                // are declared further down in this function, but this
                // callback only ever runs after the whole synchronous
                // function body (including those declarations) has
                // finished, so referencing them here is safe.
                if (submission) {
                    gradeContainer.innerHTML = "";

                    const gradeLine = document.createElement("small");
                    gradeLine.className = "d-block";
                    const gradeLabel = document.createElement("b");
                    gradeLabel.textContent = "My Grade: ";
                    gradeLine.append(gradeLabel, document.createTextNode(`${submission.score ?? "—"} / ${submission.hps ?? "?"}`));
                    gradeContainer.appendChild(gradeLine);

                    const idLine = document.createElement("small");
                    idLine.className = "text-muted d-block";
                    idLine.textContent = `Submission ID# ${submission.post_id}-${submission.submit_id}`;
                    gradeContainer.appendChild(idLine);

                    // comment is rarely populated by teachers — only show
                    // the line when there's actually something to read.
                    if (submission.comment) {
                        const commentLine = document.createElement("small");
                        commentLine.className = "d-block";
                        const commentLabel = document.createElement("b");
                        commentLabel.textContent = "Comment: ";
                        commentLine.append(commentLabel, document.createTextNode(submission.comment));
                        gradeContainer.appendChild(commentLine);
                    }

                    gradeContainer.classList.remove("d-none");

                    if (submission.submit_date) {
                        const submittedText = document.createElement("small");
                        submittedText.className = "text-success d-block";
                        submittedText.textContent = "Work submitted: " + submission.submit_date;
                        dateContainer.appendChild(submittedText);
                        updateDateContainerVisibility();
                    }
                }
            });
        }

        const footer = document.createElement("div");
        footer.className = "d-md-flex justify-content-between";

        const dateContainer = document.createElement("div");
        dateContainer.className = "text-start";

        function updateDateContainerVisibility() {
            dateContainer.classList.toggle("d-none", dateContainer.childElementCount === 0);
        }

        if (postDate) {
            const postedText = document.createElement("small");
            postedText.className = "text-muted d-block";
            postedText.textContent = "Posted: " + postDate;
            dateContainer.appendChild(postedText);
        }

        if (dueDate) {
            const dueText = document.createElement("small");
            dueText.className = isPastDue ? "text-muted d-block" : "text-danger d-block";

            const dueBold = document.createElement("b");
            dueBold.textContent = (isPastDue ? "Was due: " : "Due: ") + dueDate;

            dueText.appendChild(dueBold);
            dateContainer.appendChild(dueText);
        }

        // Always in the DOM (hidden via updateDateContainerVisibility when
        // empty) rather than only appended when non-empty at build time —
        // the lazily-fetched submission's "Work submitted: ..." line
        // (added in the fetchPostAttachments().then() callback above)
        // needs somewhere to land even on a post with no postDate/dueDate.
        footer.appendChild(dateContainer);
        updateDateContainerVisibility();

        const authorContainer = document.createElement("div");
        authorContainer.className = "text-end ms-auto";

        const authorText = document.createElement("small");

        const timeContainer = document.createElement("small");
        const timeText = document.createElement("i");
        timeText.className = "text-secondary";
        timeText.textContent = postedTime;

        timeContainer.appendChild(timeText);

        const authorName = document.createElement("b");
        authorName.textContent = author;

        authorText.append(timeContainer, " \u00A0 ", authorName);
        authorContainer.appendChild(authorText);

        footer.append(authorContainer);

        card.append(header, descriptionContainer, gradeContainer, attachmentsContainer, footer);
        return card;
    }

    function loadingClassCard(classCode, section) {
        const card = document.createElement("div");
        card.className = "card card-body shadow-sm p-4 mb-4 classCard-loading placeholder-glow";

        const headerDiv = document.createElement("div");
        headerDiv.className = "mb-2";
        const headerPlaceholder = document.createElement("span");
        headerPlaceholder.className = "placeholder col-3 bg-secondary rounded";
        headerDiv.appendChild(headerPlaceholder);
        card.appendChild(headerDiv);

        const title = document.createElement("h5");
        title.className = "card-title";
        const titleBold = document.createElement("b");
        titleBold.textContent = `📗 ${classCode}: ${section}`;
        title.appendChild(titleBold);
        card.appendChild(title);

        const contentDiv = document.createElement("div");
        contentDiv.className = "mt-3";

        const innerCard = document.createElement("div");
        innerCard.className = "card card-body shadow-sm p-4 mb-3";

        const flexRow = document.createElement("div");
        flexRow.className = "d-flex mb-2 align-items-center";

        const iconPlaceholder = document.createElement("span");
        iconPlaceholder.className = "placeholder col-1 me-2 bg-secondary rounded";
        iconPlaceholder.style.height = "2rem";
        flexRow.appendChild(iconPlaceholder);

        const textContainer = document.createElement("div");
        textContainer.className = "w-100";

        const line1 = document.createElement("span");
        line1.className = "placeholder col-6 rounded";
        textContainer.appendChild(line1);

        textContainer.appendChild(document.createElement("br"));

        const line2 = document.createElement("span");
        line2.className = "placeholder col-4 bg-secondary rounded";
        textContainer.appendChild(line2);

        flexRow.appendChild(textContainer);
        innerCard.appendChild(flexRow);

        const descDiv = document.createElement("div");
        descDiv.className = "mb-2";

        const descLine1 = document.createElement("span");
        descLine1.className = "placeholder col-12 rounded";
        descDiv.appendChild(descLine1);

        descDiv.appendChild(document.createElement("br"));

        const descLine2 = document.createElement("span");
        descLine2.className = "placeholder col-8 rounded";
        descDiv.appendChild(descLine2);

        innerCard.appendChild(descDiv);

        const footerDiv = document.createElement("div");
        footerDiv.className = "d-flex justify-content-between";

        const actionBtn1 = document.createElement("span");
        actionBtn1.className = "placeholder col-3 bg-white rounded";
        footerDiv.appendChild(actionBtn1);

        const actionBtn2 = document.createElement("span");
        actionBtn2.className = "placeholder col-3 bg-secondary rounded";
        footerDiv.appendChild(actionBtn2);

        innerCard.appendChild(footerDiv);
        contentDiv.appendChild(innerCard);
        card.appendChild(contentDiv);

        return card;
    }

    function loadingPendingTaskCard() {
        const card = document.createElement("div");
        card.className = "card card-body shadow-sm p-4 mb-3 placeholder-glow";

        const flexRow = document.createElement("div");
        flexRow.className = "d-flex mb-2 align-items-center";

        const iconPlaceholder = document.createElement("span");
        iconPlaceholder.className = "placeholder col-1 me-2 bg-secondary rounded";
        iconPlaceholder.style.height = "2rem";
        flexRow.appendChild(iconPlaceholder);

        const textContainer = document.createElement("div");
        textContainer.className = "w-100";

        const line1 = document.createElement("span");
        line1.className = "placeholder col-7 rounded";
        textContainer.appendChild(line1);
        textContainer.appendChild(document.createElement("br"));

        const line2 = document.createElement("span");
        line2.className = "placeholder col-4 bg-secondary rounded";
        textContainer.appendChild(line2);

        flexRow.appendChild(textContainer);
        card.appendChild(flexRow);

        const descLine1 = document.createElement("span");
        descLine1.className = "placeholder col-12 rounded";
        card.appendChild(descLine1);
        card.appendChild(document.createElement("br"));

        const descLine2 = document.createElement("span");
        descLine2.className = "placeholder col-9 rounded mb-2";
        card.appendChild(descLine2);

        const footerDiv = document.createElement("div");
        footerDiv.className = "d-flex justify-content-between mt-2";

        const dueSpan = document.createElement("span");
        dueSpan.className = "placeholder col-3 bg-secondary rounded";
        footerDiv.appendChild(dueSpan);

        const authorSpan = document.createElement("span");
        authorSpan.className = "placeholder col-3 bg-secondary rounded";
        footerDiv.appendChild(authorSpan);

        card.appendChild(footerDiv);
        return card;
    }

    function loadingPendingTasksSkeleton(count = 3) {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < count; i++) {
            frag.appendChild(loadingPendingTaskCard());
        }
        return frag;
    }

    function debugCard() {
        const existing = document.querySelector(".debugCard-instance");
        if (existing) {
            existing.remove();
        }

        const setting = pinnacle.props?.setting ?? {};

        const newCard = document.createElement("div");
        newCard.className = "card card-body shadow-sm p-4 mb-4 debugCard-instance";

        const header = document.createElement("h4");
        const b = document.createElement("b");
        b.textContent = "❤️ The enhancer loaded successfully!";
        header.appendChild(b);

        const paragraph = document.createElement("p");
        paragraph.className = "mb-3";
        paragraph.textContent = "Thank you for using PinnaCle Enhancer by kurtlvc @ github! These new functions and fixes will help you navigate the lms with ease! Shoutout to 3IT-A 2026-2027!";

        const announcementsHeader = document.querySelector(
            "#app > div.d-flex > main > div.container-fluid > div > div.col-xxl-9.col-xl-8.mb-5 > h4"
        );

        if (!announcementsHeader) {
            console.warn("PinnaCle Enhanced: announcements header not found, skipping debug card.");
            return;
        }

        announcementsHeader.classList.add("debugCard");
        const parent = announcementsHeader.parentNode;

        header.remove?.();
        newCard.appendChild(header);
        newCard.appendChild(paragraph);

        parent.insertBefore(newCard, announcementsHeader);
        console.log("Card Updated!");
    }

    // CONFIRMED SHAPE (see exportNotificationsMarkdown above for the full
    // note): { id (= post_id), url (absolute link to the post), message,
    // datetime, timestamp, seen }. No separate title/subject field exists,
    // so there's nothing to patch a "(untitled)" placeholder with — that
    // symptom was coming from the export function's wrong field guesses,
    // not from anything rendered in the DOM here. This just annotates each
    // notification element with its full datetime, since the stock UI only
    // shows the short "Sep 8" form (n.timestamp).
    function notificationsHandler(page) {
        const notifications = getPath(page, "props.notifications", null)
            || getPath(page, "props.notification_list", null)
            || getPath(page, "props.items", null)
            || getPath(page, "props.notifs", null);

        if (!Array.isArray(notifications) || notifications.length === 0) return;

        const candidates = [
            ...document.querySelectorAll("#app main a, #app main button, #app main .card"),
        ];

        notifications.forEach((n) => {
            const postId = n.id ?? n.post_id;
            const when = n.datetime || n.timestamp || n.created_at || null;

            // n.url is a full absolute URL (e.g. .../student/class/989/post/{urlKey});
            // pull the url_key back out of it to match against on-page hrefs,
            // since those are rendered as relative paths.
            const urlKeyMatch = typeof n.url === "string" ? n.url.match(/\/post\/([^/?#]+)/) : null;
            const urlKey = urlKeyMatch ? urlKeyMatch[1] : null;

            if (postId == null && !urlKey) return;

            let target = candidates.find((el) =>
                String(el.dataset.postId || el.dataset.post_id || "") === String(postId)
            );

            if (!target && urlKey) {
                target = candidates.find((el) => el.getAttribute("href")?.includes(`/post/${urlKey}`));
            }

            // Last resort: match on the notification's own message text,
            // since the stock UI most likely renders n.message verbatim.
            if (!target && n.message) {
                target = candidates.find((el) => el.textContent.includes(n.message));
            }

            if (!target || !when) return;

            const meta = target.querySelector(".pe-notification-meta");
            if (meta) meta.remove();

            const metaRow = document.createElement("small");
            metaRow.className = "pe-notification-meta text-muted d-block mt-1";
            metaRow.textContent = when;
            target.appendChild(metaRow);
        });
    }

    function versionTracker(page) {
        const verText = document.querySelector(
            "#app > div.d-flex > main > div.container-fluid > div > div.col-xxl-9.col-xl-8.mb-5 > div.card.card-body.shadow-sm.text-center.text-light.p-5.pb-4.mb-5 > h1 > small:nth-child(3)"
        );

        let welcomeCard = null;

        if (verText) {
            verText.textContent = "Enhanced";
            welcomeCard = verText.parentElement.parentElement;

            if (welcomeCard) {
                welcomeCard.append("v" + getPath(page, "version"));
            }
        }

        const currentVersion = getPath(page, "version", null);
        if (currentVersion === null) return;

        const storedVersion = GM_getValue("pinnacle_version", null);
        if (storedVersion !== currentVersion) {
            GM_setValue("pinnacle_version", currentVersion);
            console.log(`PinnaCle version updated from ${storedVersion} to ${currentVersion}`);
            showToast(`PinnaCle version updated from ${storedVersion} to ${currentVersion}`, "info");
            welcomeCard?.append("v" + currentVersion + " NEW UPDATE!");
        }
    }

    function validatePageData(page) {
        if (!page || typeof page !== 'object') {
            console.error("Invalid page data structure:", page);
            return false;
        }
        if (!page.component || !page.props) {
            console.error("Missing required properties in page data:", page);
            return false;
        }
        return true;
    }

    function getPath(obj, path, fallback = "N/A") {
        try {
            return path.split(".").reduce((acc, key) => acc[key], obj) ?? fallback;
        } catch (e) {
            return fallback;
        }
    }

    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
        return match ? decodeURIComponent(match[2]) : null;
    }

    // Resolves the live Inertia router instance so we can call .visit()
    // directly instead of faking clicks on existing links. Not every
    // Inertia setup exposes `window.Inertia`, so this also checks Vue 3's
    // mounted app instance as a fallback: Vue attaches the app it mounted
    // to its root DOM element as `__vue_app__` (meant for devtools), and
    // that's the same instance Inertia's Vue plugin registers itself on
    // via `app.config.globalProperties.$inertia`. `[data-page]` is
    // Inertia's own marker attribute on its root element, which is more
    // reliable to query for than assuming the root id is `#app`.
    //
    // Cached once found: Vue mounts the app once per full page load and
    // Inertia swaps pages *within* it, so the same router instance stays
    // valid for the rest of the session. A miss isn't cached, so the next
    // call just looks again (cheap, and covers the unlikely case this
    // runs before Vue has mounted).
    let cachedInertiaRouter = null;

    function getInertiaRouter() {
        if (cachedInertiaRouter) return cachedInertiaRouter;

        if (window.Inertia && typeof window.Inertia.visit === "function") {
            cachedInertiaRouter = window.Inertia;
            return cachedInertiaRouter;
        }

        const root = document.querySelector("[data-page]");
        const app = root?.__vue_app__;
        const inertia = app?.config?.globalProperties?.$inertia;

        if (inertia && typeof inertia.visit === "function") {
            cachedInertiaRouter = inertia;
            return cachedInertiaRouter;
        }

        return null;
    }

    function softRefreshCurrentPage() {
        const router = getInertiaRouter();
        if (router) {
            router.visit(window.location.pathname + window.location.search, {
                preserveScroll: true,
                preserveState: false,
                replace: true,
            });
            return true;
        }

        const currentPath = window.location.pathname;
        const candidateSelectors = [
            `a[href="${currentPath}"]`,
            `a[href="${window.location.href}"]`,
            'a[href="/student"]',
            `a[href="${window.location.origin}/student"]`,
        ];

        for (const selector of candidateSelectors) {
            const link = document.querySelector(selector);
            if (link) {
                link.click();
                return true;
            }
        }

        return false;
    }

    function inertiaVisit(url) {
        if (!url) return false;

        const absoluteUrl = new URL(url, window.location.origin).href;

        const router = getInertiaRouter();
        if (router) {
            router.visit(url, {
                preserveScroll: false,
                preserveState: false,
                replace: false,
            });
            return true;
        }

        const existing = [...document.querySelectorAll("a[href]")]
            .find((link) => {
                if (link === document.activeElement || link.closest("[data-pe-post-card]")) return false;
                try {
                    return new URL(link.href, window.location.origin).href === absoluteUrl;
                } catch (_) {
                    return false;
                }
            });

        if (existing) {
            existing.click();
            return true;
        }

        const temp = document.createElement("a");
        temp.href = absoluteUrl;
        temp.textContent = "";
        temp.style.cssText = "position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;";
        document.body.appendChild(temp);

        const beforeUrl = window.location.href;
        temp.click();
        temp.remove();

        window.setTimeout(() => {
            if (window.location.href === beforeUrl) {
                window.location.assign(absoluteUrl);
            }
        }, 650);

        return true;
    }

    async function fetchInertiaPage(url, { method = "GET", body = null } = {}) {
        const headers = {
            "X-Inertia": "true",
            "X-Inertia-Version": pinnacle ? getPath(pinnacle, "version", "") : "",
            "Accept": "text/html, application/xhtml+xml",
            "X-Requested-With": "XMLHttpRequest",
        };

        if (method !== "GET") {
            const xsrfToken = getCookie("XSRF-TOKEN");
            if (xsrfToken) {
                headers["X-XSRF-TOKEN"] = xsrfToken;
            }
            if (body) {
                headers["Content-Type"] = "application/json";
            }
        }

        const res = await fetch(url, {
            method,
            headers,
            credentials: "same-origin",
            body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 409) {
            const redirectTo = res.headers.get("X-Inertia-Location");
            const err = new Error("Inertia version mismatch (409). Reload the page. X-Inertia-Location: " + redirectTo);
            err.status = 409;
            err.redirectTo = redirectTo;
            throw err;
        }

        if (res.status === 429) {
            const retryAfterHeader = res.headers.get("Retry-After");
            const retryAfterSeconds = Number(retryAfterHeader);
            const err = new Error(`Request to ${url} failed with status 429`);
            err.status = 429;
            if (retryAfterHeader && Number.isFinite(retryAfterSeconds)) {
                err.retryAfterMs = retryAfterSeconds * 1000;
            }
            throw err;
        }

        if (!res.ok) {
            const err = new Error(`Request to ${url} failed with status ${res.status}`);
            err.status = res.status;
            throw err;
        }

        return res.json();
    }

    const GLOBAL_REQUEST_CONCURRENCY = 2;
    let activeGlobalRequests = 0;
    const globalRequestQueue = [];

    function runWithGlobalRequestLimit(taskFn) {
        return new Promise((resolve, reject) => {
            const run = () => {
                activeGlobalRequests++;
                taskFn().then(resolve, reject).finally(async () => {
                    await sleep(100 + Math.random() * 150);
                    activeGlobalRequests--;
                    const next = globalRequestQueue.shift();
                    if (next) next();
                });
            };

            if (activeGlobalRequests < GLOBAL_REQUEST_CONCURRENCY) {
                run();
            } else {
                globalRequestQueue.push(run);
            }
        });
    }

    let versionRefreshInFlight = null;

    async function refreshInertiaVersion() {
        if (!versionRefreshInFlight) {
            versionRefreshInFlight = (async () => {
                try {
                    const res = await fetch(location.href, {
                        headers: { "X-Inertia": "true", "X-Requested-With": "XMLHttpRequest" },
                        credentials: "same-origin",
                    });
                    const page = await res.json();
                    pinnacle.version = page.version;
                } finally {
                    versionRefreshInFlight = null;
                }
            })();
        }
        return versionRefreshInFlight;
    }

    async function requestWithRetry(taskFn, { maxRetries = 3, baseDelayMs = 400, maxDelayMs = 8000, onRetry = null } = {}) {
        let attempt = 0;
        while (true) {
            try {
                return await runWithGlobalRequestLimit(taskFn);
            } catch (err) {
                attempt++;
                if (attempt > maxRetries) throw err;

                if (typeof onRetry === "function") {
                    try {
                        onRetry({ attempt, error: err });
                    } catch (_) {
                        // Progress reporting must never interfere with the request.
                    }
                }

                if (err.status === 409) {
                    await refreshInertiaVersion();
                    continue;
                }

                if (err.status === 429) {
                    const delay = Math.min(err.retryAfterMs ?? baseDelayMs * 2 ** attempt, maxDelayMs);
                    await sleep(delay);
                    continue;
                }

                await sleep(Math.min(baseDelayMs * 2 ** attempt + Math.random() * 200, maxDelayMs));
            }
        }
    }

    async function fetchInertiaPagesBatch(urls, {
        concurrency = 2,
        method = "GET",
        body = null,
        maxRetries = 3,
        baseDelayMs = 400,
    } = {}) {
        const results = new Array(urls.length);
        let index = 0;

        async function worker() {
            while (index < urls.length) {
                const myIndex = index++;
                const url = urls[myIndex];
                try {
                    results[myIndex] = await requestWithRetry(
                        () => fetchInertiaPage(url, { method, body }),
                        { maxRetries, baseDelayMs },
                    );
                } catch (err) {
                    results[myIndex] = { error: err.message, url };
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, urls.length) }, worker);
        await Promise.all(workers);
        return results;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function showToast(message, type = "info", delayms = 10000) {
        const infoToast = document.querySelector("#app-toast-info");
        const successToast = document.querySelector("#app-toast-success");
        const errorToast = document.querySelector("#app-toast-error");

        const parent =
            infoToast?.parentNode ||
            successToast?.parentNode ||
            errorToast?.parentNode;

        if (!parent) {
            console.warn("PinnaCle Enhanced: Toast parent not found.");
            return;
        }

        let template;

        switch (type) {
            case "info":
                template = infoToast;
                break;
            case "success":
                template = successToast;
                break;
            case "error":
                template = errorToast;
                break;
            default:
                console.warn("PinnaCle Enhanced: Unknown toast type:", type);
                return;
        }

        if (!template) return;

        const newToast = template.cloneNode(true);
        const toastBody = newToast.querySelector(".toast-body");

        if (toastBody) {
            toastBody.textContent = message;
        }

        newToast.className = `toast ${type} show`;

        const existingToast = parent.querySelector(".toast.show");
        if (existingToast) {
            existingToast.replaceWith(newToast);
        } else {
            parent.appendChild(newToast);
        }

        if (typeof delayms === "number" && delayms > 0) {
            setTimeout(() => {
                newToast.classList.remove("show");

                setTimeout(() => {
                    if (!newToast.classList.contains("show")) {
                        newToast.remove();
                    }
                }, 300);
            }, delayms);
        }
    }

    function clearScreenBlocker(element) {
        if (!element) return;
        element.style.setProperty("display", "none", "important");
        element.style.setProperty("pointer-events", "none", "important");
        element.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "auto";
    }

    document.querySelectorAll(".screen-blocker").forEach(clearScreenBlocker);

    const appObserver = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
            if (mutation.type !== "childList") continue;

            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                if (node.matches(".screen-blocker")) {
                    clearScreenBlocker(node);
                    showToast("Please wait.", "info", 2000);
                }
                else if (node.childElementCount > 0) {
                    const innerBlockers = node.querySelectorAll(".screen-blocker");
                    if (innerBlockers.length > 0) {
                        innerBlockers.forEach(clearScreenBlocker);
                        showToast("Please wait.", "info", 2000);
                    }
                }
            }
        }
    });

    appObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

})();
