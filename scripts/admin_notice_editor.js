// 공지 편집 엔진. 화면·저장·인증은 기존 관리자 코드가 담당한다.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

export function createNoticeEditor(element) {
    const toolbar = document.getElementById('notice-toolbar');
    const buttons = [...toolbar.querySelectorAll('[data-command]')];
    const format = document.getElementById('notice-format');
    const linkDialog = document.getElementById('notice-link-dialog');
    const linkInput = document.getElementById('notice-link-url');
    let editor;
    function updateToolbar() {
        buttons.forEach(button => {
            const name = button.dataset.command;
            const active = ['bold', 'italic', 'underline', 'strike', 'bulletList', 'orderedList', 'blockquote', 'code', 'codeBlock', 'link'].includes(name) && editor.isActive(name);
            if (!['undo', 'redo', 'clear', 'horizontalRule'].includes(name)) button.setAttribute('aria-pressed', String(active));
            button.classList.toggle('color-theme', active);
            button.classList.toggle('color-type000', !active);
            button.disabled = !editor.isEditable || (['undo', 'redo'].includes(name) && !editor.can()[name]());
        });
        format.value = String([1,2,3,4,5,6].find(level => editor.isActive('heading', { level })) || 0);
        format.disabled = !editor.isEditable;
    }
    const makeEditor = (content = '', editable = false) => new Editor({
        element,
        editable, content,
        extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false, defaultProtocol: 'https' } })],
        editorProps: { attributes: { role: 'textbox', 'aria-label': '공지 본문', 'aria-multiline': 'true', 'aria-describedby': 'notice-body-help' } },
        onTransaction: () => { if (editor) updateToolbar(); },
    });
    editor = makeEditor();
    // 메뉴 클릭으로 본문 선택 영역이 사라지지 않게 한다.
    buttons.forEach(button => {
        button.addEventListener('mousedown', event => event.preventDefault());
        button.addEventListener('click', () => {
            if (!editor.isEditable) return;
            const command = button.dataset.command;
            if (command === 'link') {
                linkInput.value = editor.getAttributes('link').href || '';
                linkInput.setCustomValidity('');
                linkDialog.showModal();linkInput.focus();return;
            }
            const chain = editor.chain().focus();
            const commands = { bold:'toggleBold', italic:'toggleItalic', underline:'toggleUnderline', strike:'toggleStrike', bulletList:'toggleBulletList', orderedList:'toggleOrderedList', blockquote:'toggleBlockquote', code:'toggleCode', codeBlock:'toggleCodeBlock', horizontalRule:'setHorizontalRule', undo:'undo', redo:'redo' };
            if (command === 'clear') chain.unsetAllMarks().clearNodes().run();
            else if (commands[command]) chain[commands[command]]().run();
            toolbar.querySelector('details').open = false;
        });
    });
    format.addEventListener('change', () => {
        if (!editor.isEditable) return;
        const chain=editor.chain().focus(), level=Number(format.value);
        if (level) chain.setHeading({level}).run(); else chain.setParagraph().run();
    });
    document.getElementById('notice-link-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!editor.isEditable) return;
        const href = linkInput.value.trim();
        try {
            if (href && !['http:', 'https:', 'mailto:'].includes(new URL(href, location.origin).protocol)) throw Error();
        } catch {linkInput.setCustomValidity('http, https 또는 mailto 링크를 입력해 주세요.');linkInput.reportValidity();return;}
        const chain=editor.chain().focus().extendMarkRange('link');
        if(href)chain.setLink({href,target:'_blank'}).run();else chain.unsetLink().run();
        linkDialog.close();
    });
    linkInput.addEventListener('input',()=>linkInput.setCustomValidity(''));
    document.getElementById('notice-link-cancel').addEventListener('click',()=>linkDialog.close());
    linkDialog.addEventListener('close',()=>{if(editor.isEditable)editor.commands.focus();});
    updateToolbar();
    return {
        getHTML: () => editor.isEmpty ? '' : editor.getHTML(),
        setContent: html => { const enabled=editor.isEditable;editor.destroy();editor=undefined;editor=makeEditor(html || '',enabled);updateToolbar(); },
        setEditable: enabled => {editor.setEditable(enabled);updateToolbar();if(!enabled){toolbar.querySelector('details').open=false;if(linkDialog.open)linkDialog.close();}},
        destroy: () => editor.destroy(),
    };
}
