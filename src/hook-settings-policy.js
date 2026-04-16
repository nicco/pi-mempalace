const PI_DEFAULT_HOOK_SETTINGS = {
	silent_save: false,
	desktop_toast: true,
};

export function getDefaultPiHookSettings() {
	return { ...PI_DEFAULT_HOOK_SETTINGS };
}

export function normalizeHookSettingsPayload(payload) {
	const settings = payload && typeof payload === "object" && payload.settings && typeof payload.settings === "object" ? payload.settings : payload;
	if (!settings || typeof settings !== "object") return getDefaultPiHookSettings();
	return {
		silent_save: typeof settings.silent_save === "boolean" ? settings.silent_save : PI_DEFAULT_HOOK_SETTINGS.silent_save,
		desktop_toast: typeof settings.desktop_toast === "boolean" ? settings.desktop_toast : PI_DEFAULT_HOOK_SETTINGS.desktop_toast,
	};
}

export function shouldShowHookToast(settings) {
	return settings?.desktop_toast ?? PI_DEFAULT_HOOK_SETTINGS.desktop_toast;
}

export function shouldUseSilentSave(settings) {
	return settings?.silent_save ?? PI_DEFAULT_HOOK_SETTINGS.silent_save;
}
