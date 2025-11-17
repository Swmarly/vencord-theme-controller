// ThemeControllerPlugin.ts
// -----------------------------------------------------------------------------
// A fully featured Vencord plugin that manages which theme is active. The
// plugin exposes manual selection, randomization and scheduling controls so the
// user can precisely control when each theme is applied.
// -----------------------------------------------------------------------------

import { definePlugin } from "@utils/plugins";
import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";
import { React } from "@webpack/common";

// -----------------------------------------------------------------------------
// Types & helpers
// -----------------------------------------------------------------------------

interface ThemeInfo {
    id: string;
    name: string;
    description?: string;
}

interface ScheduleRule {
    id: string;
    name: string;
    themeId: string;
    days: number[]; // 0 (Sunday) -> 6 (Saturday)
    start: string; // HH:mm (24h)
    end: string; // HH:mm (24h)
}

type ActiveSource = "manual" | "random" | "schedule";

interface ThemeControllerState {
    lastRandomTheme: string | null;
    activeTheme: string | null;
    activeSource: ActiveSource;
    availableThemes: ThemeInfo[];
    randomQueue: string[];
}

const DAYS = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

function safeJsonParse<T>(raw: string | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function stringTimeToMinutes(str: string): number {
    const [hh, mm] = str.split(":").map((part) => Number(part));
    if (Number.isNaN(hh) || Number.isNaN(mm)) return 0;
    return hh * 60 + mm;
}

function isNowWithinRange(start: string, end: string, now: Date): boolean {
    const minutes = now.getHours() * 60 + now.getMinutes();
    const startMin = stringTimeToMinutes(start);
    const endMin = stringTimeToMinutes(end);

    if (startMin === endMin) return true;
    if (startMin < endMin) {
        return minutes >= startMin && minutes < endMin;
    }

    // Range wraps around midnight
    return minutes >= startMin || minutes < endMin;
}

// -----------------------------------------------------------------------------
// Theme discovery helpers
// -----------------------------------------------------------------------------

function getThemeRegistry(): any | null {
    const global = window as any;
    return (
        global?.Vencord?.themes ??
        global?.VencordNative?.themes ??
        global?.VencordNative?.ThemeStore ??
        global?.BdApi?.Themes ??
        null
    );
}

function readAvailableThemes(): ThemeInfo[] {
    const registry = getThemeRegistry();
    if (!registry) return [];

    if (typeof registry.getAllThemes === "function") {
        return registry.getAllThemes().map((theme: any) => ({
            id: theme.id ?? theme.file ?? theme.name,
            name: theme.name ?? theme.displayName ?? theme.id ?? "Unknown theme",
            description: theme.description ?? theme.author ?? "",
        }));
    }

    if (Array.isArray(registry.themes)) {
        return registry.themes.map((theme: any) => ({
            id: theme.id ?? theme.file ?? theme.name,
            name: theme.name ?? theme.displayName ?? theme.id ?? "Unknown theme",
            description: theme.description ?? theme.author ?? "",
        }));
    }

    const entries: ThemeInfo[] = [];
    for (const key of Object.keys(registry)) {
        const value = registry[key];
        if (value && typeof value === "object") {
            entries.push({
                id: value.id ?? key,
                name: value.name ?? value.displayName ?? key,
                description: value.description ?? "",
            });
        }
    }

    return entries;
}

function setTheme(themeId: string | null) {
    const registry = getThemeRegistry();
    if (!registry) return;

    if (typeof registry.setTheme === "function") {
        registry.setTheme(themeId);
        return;
    }

    if (typeof registry.activate === "function") {
        registry.activate(themeId);
        return;
    }

    if (typeof registry.enableTheme === "function") {
        registry.enableTheme(themeId);
        return;
    }

    if (typeof registry.toggle === "function") {
        registry.toggle(themeId);
    }
}

function getCurrentThemeId(): string | null {
    const registry = getThemeRegistry();
    if (!registry) return null;

    if (typeof registry.getCurrentTheme === "function") {
        return registry.getCurrentTheme();
    }

    if (registry.activeTheme) return registry.activeTheme;
    return null;
}

// -----------------------------------------------------------------------------
// Plugin settings definition
// -----------------------------------------------------------------------------

const settings = definePluginSettings({
    masterEnabled: {
        type: OptionType.BOOLEAN,
        description: "Enable or disable the Theme Controller globally.",
        default: true,
    },
    manualThemeId: {
        type: OptionType.STRING,
        description: "Theme ID to use when randomization and scheduling are inactive.",
        default: "",
    },
    randomEnabled: {
        type: OptionType.BOOLEAN,
        description: "Turn on random theme selection.",
        default: false,
    },
    randomPoolSerialized: {
        type: OptionType.STRING,
        description: "JSON data storing the random pool.",
        default: "[]",
    },
    randomOnStartup: {
        type: OptionType.BOOLEAN,
        description: "Pick a random theme when Discord/Vencord starts.",
        default: true,
    },
    randomIntervalEnabled: {
        type: OptionType.BOOLEAN,
        description: "Cycle through random themes on a timer.",
        default: false,
    },
    randomIntervalMinutes: {
        type: OptionType.NUMBER,
        description: "Minutes between automatic randomizations.",
        default: 60,
        step: 1,
        min: 1,
    },
    randomAvoidRepeat: {
        type: OptionType.BOOLEAN,
        description: "Avoid picking the same theme twice in a row.",
        default: true,
    },
    randomCycleMode: {
        type: OptionType.BOOLEAN,
        description: "Cycle through themes in a shuffled order before repeating.",
        default: false,
    },
    scheduleEnabled: {
        type: OptionType.BOOLEAN,
        description: "Enable time-based theme scheduling.",
        default: false,
    },
    scheduleRulesSerialized: {
        type: OptionType.STRING,
        description: "JSON storage for schedule rules.",
        default: "[]",
    },
    scheduleTimezoneOffset: {
        type: OptionType.NUMBER,
        description: "Timezone offset override in minutes (leave 0 for system).",
        default: 0,
    },
    settingsPanel: {
        type: OptionType.COMPONENT,
        description: "",
        default: null,
        getComponent: () => React.createElement(ThemeControllerSettingsPanel),
    },
});

function getRandomPool(): string[] {
    return safeJsonParse<string[]>(settings.store.randomPoolSerialized, []);
}

function setRandomPool(pool: string[]) {
    settings.store.randomPoolSerialized = JSON.stringify(pool);
}

function getScheduleRules(): ScheduleRule[] {
    return safeJsonParse<ScheduleRule[]>(settings.store.scheduleRulesSerialized, []);
}

function setScheduleRules(rules: ScheduleRule[]) {
    settings.store.scheduleRulesSerialized = JSON.stringify(rules);
}

// -----------------------------------------------------------------------------
// Randomization and scheduling engines
// -----------------------------------------------------------------------------

class ThemeControllerEngine {
    private randomTimer: number | null = null;
    private scheduleTimer: number | null = null;
    private unsubscribers: (() => void)[] = [];
    private state: ThemeControllerState = {
        lastRandomTheme: null,
        activeTheme: null,
        activeSource: "manual",
        availableThemes: [],
        randomQueue: [],
    };

    start() {
        this.state.availableThemes = readAvailableThemes();
        this.ensureManualThemeDefault();
        this.state.activeTheme = getCurrentThemeId();
        this.subscribeToSettings();
        this.setupRandomTimer();
        this.setupScheduleTimer();
        this.evaluate("start");

        if (settings.store.randomEnabled && settings.store.randomOnStartup) {
            this.triggerRandomization("startup");
        }
    }

    stop() {
        if (this.randomTimer) {
            clearInterval(this.randomTimer);
            this.randomTimer = null;
        }
        if (this.scheduleTimer) {
            clearInterval(this.scheduleTimer);
            this.scheduleTimer = null;
        }
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.unsubscribers = [];
    }

    private subscribeToSettings() {
        if (typeof settings.addChangeListener === "function") {
            this.unsubscribers.push(
                settings.addChangeListener(() => {
                    this.state.availableThemes = readAvailableThemes();
                    this.ensureManualThemeDefault();
                    this.setupRandomTimer();
                    this.setupScheduleTimer();
                    this.evaluate("settings-change");
                })
            );
        }
    }

    private ensureManualThemeDefault() {
        if (settings.store.manualThemeId) return;
        const firstTheme = this.state.availableThemes[0];
        if (firstTheme) settings.store.manualThemeId = firstTheme.id;
    }

    private setupRandomTimer() {
        if (this.randomTimer) {
            clearInterval(this.randomTimer);
            this.randomTimer = null;
        }
        if (
            settings.store.masterEnabled &&
            settings.store.randomEnabled &&
            settings.store.randomIntervalEnabled
        ) {
            const minutes = Math.max(1, Number(settings.store.randomIntervalMinutes ?? 60));
            this.randomTimer = window.setInterval(() => {
                this.triggerRandomization("interval");
            }, minutes * 60 * 1000);
        }
    }

    private setupScheduleTimer() {
        if (this.scheduleTimer) {
            clearInterval(this.scheduleTimer);
            this.scheduleTimer = null;
        }
        if (settings.store.masterEnabled && settings.store.scheduleEnabled) {
            this.scheduleTimer = window.setInterval(() => this.evaluate("schedule-tick"), 30 * 1000);
        }
    }

    private updateState(themeId: string | null, source: ActiveSource) {
        if (!themeId) return;
        if (this.state.activeTheme === themeId && this.state.activeSource === source) return;
        this.state.activeTheme = themeId;
        this.state.activeSource = source;
        setTheme(themeId);
    }

    private selectRandomTheme(): string | null {
        const pool = getRandomPool();
        const available = this.state.availableThemes
            .filter((theme) => pool.includes(theme.id))
            .map((theme) => theme.id);
        if (!available.length) return null;

        if (settings.store.randomCycleMode) {
            if (!this.state.randomQueue.length) {
                this.state.randomQueue = this.shuffleArray(available);
            }
            const next = this.state.randomQueue.shift()!;
            return next;
        }

        const avoidRepeat = settings.store.randomAvoidRepeat;
        const filtered = avoidRepeat && this.state.lastRandomTheme
            ? available.filter((id) => id !== this.state.lastRandomTheme)
            : available;

        const poolToUse = filtered.length ? filtered : available;
        const index = Math.floor(Math.random() * poolToUse.length);
        return poolToUse[index];
    }

    private shuffleArray(array: string[]): string[] {
        const copy = [...array];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    triggerRandomization(reason: string) {
        if (!settings.store.masterEnabled || !settings.store.randomEnabled) return;
        const themeId = this.selectRandomTheme();
        if (!themeId) return;
        this.state.lastRandomTheme = themeId;
        if (this.getScheduledTheme(new Date())) {
            this.evaluate(reason);
            return; // schedule takes priority; theme will be applied later
        }
        this.updateState(themeId, "random");
    }

    private getScheduledTheme(date: Date): string | null {
        if (!settings.store.scheduleEnabled) return null;
        const rules = getScheduleRules();
        const tzOffset = Number(settings.store.scheduleTimezoneOffset ?? 0);
        const now = tzOffset === 0 ? date : new Date(date.getTime() + tzOffset * 60 * 1000);
        const day = now.getDay();

        for (const rule of rules) {
            if (!rule.themeId || !rule.days?.includes(day)) continue;
            if (isNowWithinRange(rule.start ?? "00:00", rule.end ?? "23:59", now)) {
                return rule.themeId;
            }
        }
        return null;
    }

    evaluate(reason: string) {
        if (!settings.store.masterEnabled) return;
        const now = new Date();
        const scheduleTheme = this.getScheduledTheme(now);
        if (scheduleTheme) {
            this.updateState(scheduleTheme, "schedule");
            return;
        }

        if (settings.store.randomEnabled && this.state.lastRandomTheme) {
            this.updateState(this.state.lastRandomTheme, "random");
            return;
        }

        if (settings.store.manualThemeId) {
            this.updateState(settings.store.manualThemeId, "manual");
        }
    }
}

const engine = new ThemeControllerEngine();

// -----------------------------------------------------------------------------
// Settings UI components
// -----------------------------------------------------------------------------

function ThemeControllerSettingsPanel() {
    const [_, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

    const themes = React.useMemo(() => readAvailableThemes(), []);

    React.useEffect(() => {
        const id = window.setInterval(() => forceUpdate(), 5000);
        return () => window.clearInterval(id);
    }, []);

    const pool = getRandomPool();
    const rules = getScheduleRules();

    return React.createElement(
        "div",
        { className: "vencord-theme-controller" },
        React.createElement("h2", null, "Theme Controller"),
        React.createElement(
            "section",
            null,
            React.createElement("h3", null, "General"),
            createToggle(
                "Master toggle",
                settings.store.masterEnabled,
                (value) => (settings.store.masterEnabled = value)
            ),
            React.createElement("p", null, "Select a theme to apply when no schedule or random rule is active."),
            React.createElement(ThemeRadioList, {
                themes,
                selected: settings.store.manualThemeId,
                onSelect: (id: string) => {
                    settings.store.manualThemeId = id;
                    engine.evaluate("manual-select");
                },
            })
        ),
        React.createElement(
            "section",
            null,
            React.createElement("h3", null, "Randomization"),
            createToggle(
                "Enable random mode",
                settings.store.randomEnabled,
                (value) => {
                    settings.store.randomEnabled = value;
                    engine.setupRandomTimer();
                    engine.evaluate("random-toggle");
                }
            ),
            createToggle(
                "Randomize on startup",
                settings.store.randomOnStartup,
                (value) => (settings.store.randomOnStartup = value)
            ),
            createToggle(
                "Run on interval",
                settings.store.randomIntervalEnabled,
                (value) => {
                    settings.store.randomIntervalEnabled = value;
                    engine.setupRandomTimer();
                }
            ),
            React.createElement(NumberInput, {
                label: "Interval (minutes)",
                value: settings.store.randomIntervalMinutes,
                min: 1,
                onChange: (v: number) => {
                    settings.store.randomIntervalMinutes = v;
                    engine.setupRandomTimer();
                },
            }),
            createToggle(
                "Avoid repeats",
                settings.store.randomAvoidRepeat,
                (value) => (settings.store.randomAvoidRepeat = value)
            ),
            createToggle(
                "Cycle through shuffled order",
                settings.store.randomCycleMode,
                (value) => (settings.store.randomCycleMode = value)
            ),
            React.createElement("h4", null, "Theme pool"),
            React.createElement(ThemeMultiSelect, {
                themes,
                selected: pool,
                onChange: (ids: string[]) => setRandomPool(ids),
            }),
            React.createElement(
                "button",
                {
                    className: "vencord-theme-controller__randomize-now",
                    onClick: () => engine.triggerRandomization("manual"),
                },
                "Pick random now"
            )
        ),
        React.createElement(
            "section",
            null,
            React.createElement("h3", null, "Scheduling"),
            createToggle(
                "Enable scheduling",
                settings.store.scheduleEnabled,
                (value) => {
                    settings.store.scheduleEnabled = value;
                    engine.setupScheduleTimer();
                    engine.evaluate("schedule-toggle");
                }
            ),
            React.createElement(NumberInput, {
                label: "Timezone offset (minutes)",
                value: settings.store.scheduleTimezoneOffset,
                onChange: (v: number) => (settings.store.scheduleTimezoneOffset = v),
            }),
            React.createElement(ScheduleEditor, {
                themes,
                rules,
                onChange: (next: ScheduleRule[]) => {
                    setScheduleRules(next);
                    engine.evaluate("schedule-update");
                },
            })
        )
    );
}

function createToggle(label: string, value: boolean, onChange: (value: boolean) => void) {
    return React.createElement(
        "label",
        { className: "vencord-theme-controller__toggle" },
        React.createElement("input", {
            type: "checkbox",
            checked: value,
            onChange: (event: any) => onChange(event.target.checked),
        }),
        React.createElement("span", null, label)
    );
}

interface ThemeRadioListProps {
    themes: ThemeInfo[];
    selected: string | null;
    onSelect(id: string): void;
}

function ThemeRadioList(props: ThemeRadioListProps) {
    if (!props.themes.length) {
        return React.createElement("p", null, "No themes available. Add themes to Vencord first.");
    }
    return React.createElement(
        "div",
        { className: "vencord-theme-controller__theme-list" },
        props.themes.map((theme) =>
            React.createElement(
                "label",
                { key: theme.id },
                React.createElement("input", {
                    type: "radio",
                    name: "theme-controller-manual",
                    checked: props.selected === theme.id,
                    onChange: () => props.onSelect(theme.id),
                }),
                React.createElement(
                    "span",
                    null,
                    theme.name,
                    theme.description ? ` — ${theme.description}` : ""
                )
            )
        )
    );
}

interface ThemeMultiSelectProps {
    themes: ThemeInfo[];
    selected: string[];
    onChange(ids: string[]): void;
}

function ThemeMultiSelect(props: ThemeMultiSelectProps) {
    const toggle = (id: string) => {
        const next = props.selected.includes(id)
            ? props.selected.filter((item) => item !== id)
            : [...props.selected, id];
        props.onChange(next);
    };

    return React.createElement(
        "div",
        { className: "vencord-theme-controller__multi" },
        props.themes.map((theme) =>
            React.createElement(
                "label",
                { key: theme.id },
                React.createElement("input", {
                    type: "checkbox",
                    checked: props.selected.includes(theme.id),
                    onChange: () => toggle(theme.id),
                }),
                React.createElement("span", null, theme.name)
            )
        )
    );
}

interface NumberInputProps {
    label: string;
    value: number;
    min?: number;
    max?: number;
    onChange(value: number): void;
}

function NumberInput(props: NumberInputProps) {
    return React.createElement(
        "label",
        { className: "vencord-theme-controller__number" },
        React.createElement("span", null, props.label),
        React.createElement("input", {
            type: "number",
            value: props.value,
            min: props.min,
            max: props.max,
            onChange: (event: any) => props.onChange(Number(event.target.value)),
        })
    );
}

interface ScheduleEditorProps {
    themes: ThemeInfo[];
    rules: ScheduleRule[];
    onChange(rules: ScheduleRule[]): void;
}

function ScheduleEditor({ themes, rules, onChange }: ScheduleEditorProps) {
    const addRule = () => {
        const firstTheme = themes[0]?.id ?? "";
        const newRule: ScheduleRule = {
            id: `${Date.now()}-${Math.random()}`,
            name: `Rule ${rules.length + 1}`,
            themeId: firstTheme,
            days: [new Date().getDay()],
            start: "08:00",
            end: "17:00",
        };
        onChange([...rules, newRule]);
    };

    const updateRule = (id: string, partial: Partial<ScheduleRule>) => {
        onChange(
            rules.map((rule) => (rule.id === id ? { ...rule, ...partial } : rule))
        );
    };

    const removeRule = (id: string) => {
        onChange(rules.filter((rule) => rule.id !== id));
    };

    return React.createElement(
        "div",
        { className: "vencord-theme-controller__schedule" },
        React.createElement(
            "button",
            { onClick: addRule },
            "Add rule"
        ),
        !rules.length && React.createElement("p", null, "No schedule rules defined."),
        rules.map((rule) =>
            React.createElement(
                "div",
                { key: rule.id, className: "vencord-theme-controller__rule" },
                React.createElement(
                    "label",
                    null,
                    "Name",
                    React.createElement("input", {
                        type: "text",
                        value: rule.name,
                        onChange: (event: any) => updateRule(rule.id, { name: event.target.value }),
                    })
                ),
                React.createElement(
                    "label",
                    null,
                    "Theme",
                    React.createElement(
                        "select",
                        {
                            value: rule.themeId,
                            onChange: (event: any) => updateRule(rule.id, { themeId: event.target.value }),
                        },
                        themes.map((theme) =>
                            React.createElement(
                                "option",
                                { key: theme.id, value: theme.id },
                                theme.name
                            )
                        )
                    )
                ),
                React.createElement(DayPicker, {
                    selectedDays: rule.days,
                    onChange: (days) => updateRule(rule.id, { days }),
                }),
                React.createElement(TimeRangeInput, {
                    start: rule.start,
                    end: rule.end,
                    onChange: (start, end) => updateRule(rule.id, { start, end }),
                }),
                React.createElement(
                    "button",
                    { onClick: () => removeRule(rule.id) },
                    "Remove"
                )
            )
        )
    );
}

interface DayPickerProps {
    selectedDays: number[];
    onChange(days: number[]): void;
}

function DayPicker({ selectedDays, onChange }: DayPickerProps) {
    const toggle = (day: number) => {
        const next = selectedDays.includes(day)
            ? selectedDays.filter((d) => d !== day)
            : [...selectedDays, day];
        onChange(next.sort());
    };

    return React.createElement(
        "div",
        { className: "vencord-theme-controller__days" },
        DAYS.map((day, index) =>
            React.createElement(
                "label",
                { key: day },
                React.createElement("input", {
                    type: "checkbox",
                    checked: selectedDays.includes(index),
                    onChange: () => toggle(index),
                }),
                React.createElement("span", null, day)
            )
        )
    );
}

interface TimeRangeInputProps {
    start: string;
    end: string;
    onChange(start: string, end: string): void;
}

function TimeRangeInput({ start, end, onChange }: TimeRangeInputProps) {
    return React.createElement(
        "div",
        { className: "vencord-theme-controller__time" },
        React.createElement(
            "label",
            null,
            "Start",
            React.createElement("input", {
                type: "time",
                value: start,
                onChange: (event: any) => onChange(event.target.value, end),
            })
        ),
        React.createElement(
            "label",
            null,
            "End",
            React.createElement("input", {
                type: "time",
                value: end,
                onChange: (event: any) => onChange(start, event.target.value),
            })
        )
    );
}

// -----------------------------------------------------------------------------
// Plugin registration
// -----------------------------------------------------------------------------

export default definePlugin({
    name: "ThemeController",
    description:
        "Powerful controller for Vencord themes with manual selection, randomization and scheduling.",
    authors: [{ id: 1, name: "OpenAI Assistant" }],
    settings,
    start() {
        engine.start();
    },
    stop() {
        engine.stop();
    },
});

// -----------------------------------------------------------------------------
// Usage helper text (for reference inside the source file)
// -----------------------------------------------------------------------------
// Theme discovery: readAvailableThemes() looks at common theme registries used by
// Vencord and BD compatible loaders. The helper gracefully falls back to empty
// arrays when no themes exist so the UI can warn the user.
//
// Randomization: triggerRandomization() is invoked for manual requests, startup
// runs and interval timers. The helper respects the "avoid repeats" and
// optional shuffle/cycle preferences so the user can precisely control the
// randomness.
//
// Scheduling: getScheduledTheme() evaluates the serialized schedule rules in
// priority order. Scheduling always takes priority over random/manual themes.
// Once scheduling is inactive the latest random or manual theme becomes active
// again when evaluate() runs.
