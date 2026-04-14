// form-extractor.js - Analyzes the DOM to extract form structures

window.__memuxFormExtractor = {
  extract: function () {
    const fields = [];

    // Tactic 1: Google Forms specifically
    const gFormItems = document.querySelectorAll('div[role="listitem"]');
    if (gFormItems && gFormItems.length > 0) {
      gFormItems.forEach((item) => {
        // Try to find the title/label. Usually it's in a specific div role="heading" or just the first text-heavy div.
        const labelEl = item.querySelector('div[role="heading"]') || item.querySelector('.M7eMe');
        let label = labelEl ? labelEl.innerText.trim() : "";

        // Fallback for label
        if (!label) {
            // Find the element that looks like a title
            const labelCandidates = Array.from(item.querySelectorAll('span, div')).filter(el => {
                const style = window.getComputedStyle(el);
                return parseInt(style.fontSize) > 14 && el.innerText.trim().length > 0;
            });
            if (labelCandidates.length > 0) {
                label = labelCandidates[0].innerText.trim();
            }
        }

        // Clean up label (e.g. remove asterisk for required)
        label = label.replace(/\*/g, '').trim();

        // Find standard inputs inside the item
        const inputs = item.querySelectorAll('input:not([type="hidden"]), textarea, select');
        
        inputs.forEach((input) => {
            const inputType = input.type || input.tagName.toLowerCase();
            const name = input.name || "";
            const isFile = inputType === "file";
            
            // Avoid duplicate inputs for radio/checkbox groups if we already tracked the group
            const existing = fields.find(f => f.name === name);
            if (!existing || name === "") {
                fields.push({
                    id: input.id || "",
                    name: name,
                    type: isFile ? "file" : inputType,
                    label: label || name,
                    required: item.innerText.includes("*") || input.required,
                });
            }
        });

        // Some Google Form inputs are heavily obfuscated (divs acting as selects etc).
        // If no native inputs found, look for hidden inputs that hold the state.
        if (inputs.length === 0) {
            const hiddenInputs = item.querySelectorAll('input[type="hidden"]');
            hiddenInputs.forEach((hInput) => {
                // Ignore CSRF tokens etc. Look for entry.*
                if (hInput.name && hInput.name.startsWith("entry.")) {
                    fields.push({
                        id: hInput.id || "",
                        name: hInput.name,
                        type: "text", // assuming text for fallback
                        label: label,
                        required: item.innerText.includes("*"),
                    });
                }
            });
        }
      });
      
      return {
          platform: "google_forms",
          title: document.title,
          url: window.location.href,
          fields: fields
      };
    }

    // Tactic 2: Generic HTML Forms
    const genericForms = document.querySelectorAll('form');
    let targetForm = genericForms[0]; // just pick the first standard form for now
    
    if (targetForm) {
      const inputs = targetForm.querySelectorAll('input:not([type="hidden"]), textarea, select');
      inputs.forEach((input) => {
          let label = "";
          // Check for associated label
          if (input.id) {
              const labelEl = document.querySelector(`label[for="${input.id}"]`);
              if (labelEl) label = labelEl.innerText.trim();
          }
          if (!label && input.closest('label')) {
              label = input.closest('label').innerText.replace(input.value || '', '').trim();
          }
          if (!label) {
              label = input.getAttribute('placeholder') || input.name || "Unknown Field";
          }
          
          fields.push({
              id: input.id || "",
              name: input.name || "",
              type: input.type || input.tagName.toLowerCase(),
              label: label,
              required: input.required || false,
          });
      });
      
      return {
          platform: "generic",
          title: document.title,
          url: window.location.href,
          fields: fields
      };
    }

    return { error: "No forms found on page." };
  }
};
