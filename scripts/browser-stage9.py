#!/usr/bin/env python3
"""Optional synthetic browser checks; requires Playwright and a Chromium executable.

Serves no files and contacts no provider: actual local UI modules execute through
an in-memory import map over a small synthetic host. This is not live SillyTavern QA.
"""
import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = [('desktop', 1440, 900), ('tablet', 820, 1180),
             ('mobile', 390, 720), ('reduced-height', 390, 430)]
IMAGE = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000b49444154789c636000020000050001a5f645400000000049454e44ae426082'
)


def rewrite_local_imports(source):
    source = re.sub(r"(['\"])\./([^'\"]+\.js)\1",
                    lambda match: match[1] + 'delta:' + match[2] + match[1], source)
    return (source.replace('/delta/', 'delta:')
            .replace('../../../extensions.js', 'host:extensions')
            .replace('../../../utils.js', 'host:utils'))


def mount_fixture(page):
    html = (ROOT / 'tests/fixtures/stage9-browser.html').read_text()
    entry = re.search(r'<script type="module">([\s\S]*)</script>', html).group(1)
    shell = re.sub(r'<script type="module">[\s\S]*</script>', '', html)
    shell = shell.replace('<link rel="stylesheet" href="/delta/style.css">',
                          '<style>' + (ROOT / 'style.css').read_text() + '</style>')
    modules = {'delta:' + file.name: rewrite_local_imports(file.read_text())
               for file in ROOT.glob('*.js')}
    modules['host:extensions'] = ('export const extension_settings=window.settings; '
                                  'export function getContext(){return window.host}')
    modules['host:utils'] = 'export async function copyText(value){window.copied=value}'
    page.set_content(shell)
    # about:blank has no localStorage origin. This is only a launcher-position stub.
    page.evaluate("Object.defineProperty(window,'localStorage',{value:{getItem(){return null},setItem(){}}})")
    page.evaluate("""({modules, entry}) => {
        const imports = {};
        for (const [key, source] of Object.entries(modules)) {
            imports[key] = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
        }
        const map = document.createElement('script');
        map.type = 'importmap'; map.textContent = JSON.stringify({imports});
        document.head.append(map);
        const script = document.createElement('script');
        script.type = 'module'; script.textContent = entry; document.body.append(script);
    }""", {'modules': modules, 'entry': rewrite_local_imports(entry)})
    page.wait_for_function('window.ready === true')
    page.wait_for_timeout(150)


def reachable(locator, height):
    box = locator.bounding_box()
    assert box and box['y'] >= 0 and box['y'] + box['height'] <= height + 1, box


def run_viewport(browser, name, width, height, output):
    context = browser.new_context(viewport={'width': width, 'height': height}, has_touch=name != 'desktop')
    page = context.new_page()
    page.set_default_timeout(5000)
    print('Checking', name, flush=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    mount_fixture(page)
    assert page.locator('#npc_state_delta_calendar_birthdays_group').count() == 1
    page.locator('#npc_state_delta_calendar_birthdays_group > summary').click()
    page.locator('#npc_state_delta_calendar_months').fill('Redleaf:30\nSunwane:31')
    page.locator('#npc_state_delta_save_calendar').click()
    assert page.evaluate('settings.npc_state_delta.calendarConfig.currentYear') is None
    page.evaluate("document.getElementById('npc_state_delta_dossier_root').__npcStateDeltaStage1Ui.open()")
    page.wait_for_selector('.delta-cast-card')
    page.wait_for_timeout(100)
    assert page.locator('.delta-continuity-birthday-card').count() == 1
    assert page.locator('.delta-appearance-form-summary').count() == 1
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name + ' overflow'
    reachable(page.locator('.delta-close'), height)
    card = page.locator('.delta-cast-card').first.bounding_box()
    rail = page.locator('.delta-cast-list').bounding_box()
    assert card['height'] > 90 and card['y'] + card['height'] <= rail['y'] + rail['height'] + 1, (name, card, rail)
    page.screenshot(path=str(output / (name + '-dossier.png')))

    # An unrelated live update must not recreate appearance content or lose disclosure state/focus.
    page.evaluate("""window.savedAppearance = document.querySelector('.delta-appearance-form-summary');
        savedAppearance.open = true; savedAppearance.querySelector('summary').focus();
        window.savedDocument = document.querySelector('.delta-document');
        window.savedScroll = savedDocument.scrollTop;
        state.npcs[0].mood = 'Changed'; refreshUi();""")
    page.wait_for_timeout(100)
    assert page.evaluate("savedAppearance === document.querySelector('.delta-appearance-form-summary') && savedAppearance.open")
    assert page.evaluate("document.activeElement === savedAppearance.querySelector('summary')")
    assert page.evaluate('savedDocument.scrollTop === savedScroll')

    page.evaluate('tools.openPortraitTools("npc-0")')
    page.locator('#npc_state_delta_tools_positive').fill('Manual golden-blue hair prompt')
    page.evaluate('state.npcs[0].mood = "Updated again"; refreshUi()')
    page.wait_for_timeout(100)
    assert page.locator('#npc_state_delta_tools_positive').input_value() == 'Manual golden-blue hair prompt'
    reachable(page.locator('#npc_state_delta_tools_overlay [data-delta-tools-close]').first, height)
    page.screenshot(path=str(output / (name + '-portrait.png')))
    page.keyboard.press('Escape')
    page.wait_for_selector('#npc_state_delta_tools_overlay', state='detached')
    page.evaluate('tools.openPortraitTools("npc-0")')
    assert page.locator('#npc_state_delta_tools_positive').input_value() == 'Manual golden-blue hair prompt'
    page.locator('input.delta-tools-portrait-file').set_input_files({'name': 'synthetic.png', 'mimeType': 'image/png', 'buffer': IMAGE})
    page.wait_for_selector('#npc_state_delta_tools_overlay', state='detached')
    page.wait_for_timeout(100)
    assert page.evaluate('counts.applied') == 1
    assert page.locator('.delta-hero img').count() >= 1
    assert page.locator('.delta-cast-card.selected img').count() == 1
    assert page.evaluate("savedAppearance === document.querySelector('.delta-appearance-form-summary')")

    # A previous upload's delayed save must not close or notify a replacement dialog.
    page.evaluate('tools.openPortraitTools("npc-0")')
    page.evaluate('() => { window.flushGate = new Promise(resolve => window.releaseFlush = resolve); }')
    page.locator('input.delta-tools-portrait-file').set_input_files({'name': 'second.png', 'mimeType': 'image/png', 'buffer': IMAGE})
    page.wait_for_function('counts.applied === 2')
    page.evaluate('diagnostics.openDiagnostics(); window.toastCount = toasts.length;')
    page.evaluate('releaseFlush(); window.flushGate = null')
    page.wait_for_timeout(100)
    assert page.locator('.delta-tools-diagnostics').count() == 1
    assert page.evaluate('toasts.length === toastCount')
    page.keyboard.press('Escape')
    page.wait_for_selector('#npc_state_delta_tools_overlay', state='detached')

    page.evaluate('NPCStateDelta.openEditor("npc-0")')
    page.wait_for_selector('.delta-editor-appearance-forms')
    assert not page.locator('[data-delta-unclassified-holder]').is_visible()
    page.locator('[data-delta-appearance-forms]').fill(
        'Human | Golden-blue hair, ordinary human ears.\nRaven | Black feathers, beak and wings.\nMist | Pale mist.')
    assert page.locator('[data-delta-current-form] option[value="Mist"]').count() == 1
    page.locator('#npc_state_delta_edit_goal').fill('Unsaved unrelated goal')
    page.locator('[data-delta-current-form]').select_option('Mist')
    page.evaluate('() => { window.flushGate = new Promise(resolve => window.releaseFlush = resolve); }')
    page.locator('[data-delta-apply-appearance]').click()
    page.locator('[data-delta-overall-appearance]').fill('Newer unsaved appearance draft')
    page.evaluate('releaseFlush(); window.flushGate = null')
    page.wait_for_timeout(100)
    assert page.evaluate('state.npcs[0].currentForm') == 'Mist'
    assert page.locator('#npc_state_delta_edit_goal').input_value() == 'Unsaved unrelated goal'
    assert page.locator('[data-delta-overall-appearance]').input_value() == 'Newer unsaved appearance draft'

    # Life-state apply shares the canonical API and must not clobber a newer selected choice.
    page.locator('.delta-editor-advanced > summary').click()
    page.locator('[data-delta-life-state]').select_option('alive')
    page.evaluate('() => { window.flushGate = new Promise(resolve => window.releaseFlush = resolve); }')
    page.locator('[data-delta-apply-life]').click()
    page.locator('[data-delta-life-state]').select_option('unknown')
    page.evaluate('releaseFlush(); window.flushGate = null')
    page.wait_for_timeout(100)
    assert page.evaluate('state.npcs[0].lifeState') == 'alive'
    assert page.locator('[data-delta-life-state]').input_value() == 'unknown'
    assert page.locator('#npc_state_delta_edit_goal').input_value() == 'Unsaved unrelated goal'
    page.screenshot(path=str(output / (name + '-editor.png')))
    reachable(page.locator('[data-test-close]'), height)
    page.locator('[data-test-close]').click()

    before = page.evaluate('({...counts})')
    page.evaluate('diagnostics.openDiagnostics()')
    page.wait_for_timeout(100)
    after = page.evaluate('({...counts})')
    assert after['getState'] == before['getState'] and after['scan'] == before['scan']
    page.keyboard.press('Escape')
    page.wait_for_selector('#npc_state_delta_tools_overlay', state='detached')
    page.evaluate("""window.domWrites = 0;
        window.qaObserver = new MutationObserver(records => domWrites += records.length);
        qaObserver.observe(document.getElementById('npc_state_delta_dossier_root'),
            {subtree:true, childList:true, characterData:true});""")
    page.wait_for_timeout(500)
    idle = page.evaluate('domWrites')
    assert idle == 0, (name, idle)
    assert not errors, errors
    result = {'viewport': name, 'width': width, 'height': height, 'counts': after,
              'idleDossierMutations500ms': idle, 'pageErrors': errors,
              'checks': 'dedicated calendar; visible rail; unchanged nodes/focus/scroll; portrait drafts/upload/thumbnails; forms and lifecycle async drafts; reachable modal controls; Escape; bounded diagnostics'}
    context.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default='/usr/bin/chromium', help='Installed Chromium executable')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist/browser-stage9')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.browser, headless=True, args=['--no-sandbox'])
        try:
            results = [run_viewport(browser, *viewport, args.output) for viewport in VIEWPORTS]
        finally:
            browser.close()
    (args.output / 'results.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
