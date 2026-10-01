/**
 * Componente genérico de senha, reutilizado no Cadastro (conta) e no
 * Cadastro de Funcionário ("Novo usuário" em Gerenciar Usuários):
 *   - checklist com as regras de senha, atualizada a cada tecla digitada;
 *   - botão de mostrar/ocultar a senha (ícone de olho).
 *
 * As regras abaixo são exatamente as mesmas (e na mesma ordem) aplicadas
 * no back-end em Hydra\Support\PasswordPolicy::validar() — qualquer
 * alteração aqui deve ser replicada lá também.
 */
(function () {
    'use strict';

    const RULES = [
        { id: 'maiuscula', label: 'Pelo menos uma letra maiúscula', test: (v) => /[A-Z]/.test(v) },
        { id: 'numero', label: 'No mínimo um número', test: (v) => /\d/.test(v) },
        { id: 'minuscula', label: 'Pelo menos uma letra minúscula', test: (v) => /[a-z]/.test(v) },
        { id: 'especial', label: 'Um caractere especial (ex.: ! @ # $ %)', test: (v) => /[^A-Za-z0-9]/.test(v) },
        { id: 'tamanho', label: 'Total de oito caracteres válidos', test: (v) => v.length >= 8 },
    ];

    const EYE_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.27 21.27 0 0 1 5.06-5.94M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 7 11 7a21.27 21.27 0 0 1-2.77 3.9M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

    /** @param {string} valor */
    function senhaAtendeRegras(valor) {
        return RULES.every((regra) => regra.test(valor || ''));
    }

    /** Primeira regra que a senha ainda não atende (ou null se estiver tudo ok). */
    function primeiraRegraFalha(valor) {
        const regra = RULES.find((r) => !r.test(valor || ''));
        return regra ? regra.label : null;
    }

    /** Monta o HTML do checklist dentro de containerEl e devolve um objeto com update(valor). */
    function criarChecklist(containerEl) {
        containerEl.classList.add('hydro-pwd-rules');
        containerEl.innerHTML =
            '<p class="hydro-pwd-rules-title">Regras da senha:</p>' +
            '<ul class="hydro-pwd-rules-list">' +
            RULES.map((r) => `<li data-rule="${r.id}" class="hydro-pwd-rule"><span class="hydro-pwd-rule-icon"></span><span>${r.label}</span></li>`).join('') +
            '</ul>';

        function update(valor) {
            RULES.forEach((regra) => {
                const li = containerEl.querySelector(`[data-rule="${regra.id}"]`);
                if (!li) return;
                const ok = regra.test(valor || '');
                li.classList.toggle('hydro-pwd-rule-ok', ok);
                li.classList.toggle('hydro-pwd-rule-fail', !ok);
            });
        }

        update('');
        return { update };
    }

    /** Cria o checklist em containerEl e liga a atualização ao vivo conforme inputEl é digitado. */
    function ligarChecklist(inputEl, containerEl) {
        const checklist = criarChecklist(containerEl);
        checklist.update(inputEl.value);
        inputEl.addEventListener('input', () => checklist.update(inputEl.value));
        return checklist;
    }

    /** Liga um botão de mostrar/ocultar senha (ícone de olho) a um input de senha. */
    function ligarToggleSenha(inputEl, buttonEl) {
        buttonEl.innerHTML = EYE_OPEN;
        buttonEl.setAttribute('aria-label', 'Mostrar senha');
        buttonEl.addEventListener('click', () => {
            const estaMostrando = inputEl.type === 'text';
            inputEl.type = estaMostrando ? 'password' : 'text';
            buttonEl.innerHTML = estaMostrando ? EYE_OPEN : EYE_OFF;
            buttonEl.setAttribute('aria-label', estaMostrando ? 'Mostrar senha' : 'Ocultar senha');
        });
    }

    window.HydraPasswordRules = {
        RULES,
        senhaAtendeRegras,
        primeiraRegraFalha,
        ligarChecklist,
        ligarToggleSenha,
    };
})();
