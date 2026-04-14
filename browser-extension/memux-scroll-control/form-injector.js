// form-injector.js - Safely injects the AI mapping back into the DOM using simulated events

window.__memuxFormInjector = {
    inject: async function(mappedFields, fileBlobs) {
        for (const [fieldName, val] of Object.entries(mappedFields)) {
            // Find input matching name. Often inputs are explicitly named.
            const el = document.querySelector(`[name="${fieldName}"]`);
            if (el) {
                // To bypass React / Vue listeners, we must focus, set value synthetically, and trigger events
                
                // Set value via native value setter
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
                const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
                
                el.focus();
                
                if (el.tagName.toLowerCase() === 'textarea' && nativeTextAreaValueSetter) {
                    nativeTextAreaValueSetter.call(el, val);
                } else if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(el, val);
                } else {
                    el.value = val;
                }

                // Make visual indicator
                el.style.border = "2px solid #10b981"; // green border glow
                el.style.backgroundColor = "rgba(16, 185, 129, 0.05)";

                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
            }
        }

        for (const [fieldName, base64Blob] of Object.entries(fileBlobs || {})) {
            const el = document.querySelector(`[name="${fieldName}"]`);
            if (el && el.type === 'file') {
                try {
                    // Reconstruct the blob from base64
                    const byteChars = atob(base64Blob);
                    const byteNumbers = new Array(byteChars.length);
                    for (let i = 0; i < byteChars.length; i++) {
                        byteNumbers[i] = byteChars.charCodeAt(i);
                    }
                    const byteArray = new Uint8Array(byteNumbers);
                    // Usually we assume PDF from the profile datalake
                    const blob = new Blob([byteArray], {type: "application/pdf"});
                    
                    const dt = new DataTransfer();
                    dt.items.add(new File([blob], "resume_document.pdf", { type: "application/pdf" })); // hardcode name for brevity or pass via AI
                    
                    el.files = dt.files;
                    el.style.border = "2px solid #10b981";
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } catch(e) {
                    console.error("Failed to inject file blob into form.", e);
                }
            }
        }
    }
}
