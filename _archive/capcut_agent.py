"""
CapCut Agent - Windows Tray App
pip install pystray pillow flask pyautogui psutil requests uiautomation
"""
import os, sys, time, glob, threading, subprocess, requests, io, base64, zipfile, ctypes
from flask import Flask, request, jsonify
import pyautogui
import psutil
import pystray
from PIL import Image, ImageDraw
import uiautomation as auto

CAPCUT_EXE = os.path.expandvars(r'%LOCALAPPDATA%\CapCut\Apps\CapCut.exe')
DRAFT_ROOT = os.path.expandvars(r'%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft')
VIDEO_OUT  = os.path.expandvars(r'%USERPROFILE%\Videos')
LINUX_URL  = 'http://192.168.50.43:3000'
PORT       = 5000

pyautogui.FAILSAFE = True
pyautogui.PAUSE    = 0.3
auto.SetGlobalSearchTimeout(30)

app     = Flask(__name__)
_icon   = None
_status = 'Idle'

def set_status(msg):
    global _status
    _status = msg
    print(f'[Agent] {msg}')
    if _icon:
        _icon.title = f'CapCut Agent — {msg}'

def make_icon(color='green'):
    size = 64
    img  = Image.new('RGB', (size, size), (0,0,0))
    dc   = ImageDraw.Draw(img)
    c    = {'green':(0,204,68),'yellow':(255,204,0),'red':(255,51,51)}.get(color,(0,204,68))
    dc.ellipse([4,4,size-4,size-4], fill=c)
    return img

# ── Windows API ───────────────────────────────────────────────────────────────
def focus_capcut():
    found = []
    def cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
        if 'capcut' in buf.value.lower():
            found.append(hwnd)
        return True
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_int, ctypes.c_int)
    ctypes.windll.user32.EnumWindows(WNDENUMPROC(cb), 0)
    if found:
        ctypes.windll.user32.ShowWindow(found[0], 3)
        ctypes.windll.user32.SetForegroundWindow(found[0])
        time.sleep(1)
        return True
    return False

def capcut_running():
    return any(p.name().lower() == 'capcut.exe' for p in psutil.process_iter(['name']))

def kill_capcut():
    for p in psutil.process_iter(['name']):
        if p.name().lower() == 'capcut.exe':
            p.kill()
    time.sleep(2)

def open_capcut():
    subprocess.Popen([CAPCUT_EXE])
    for _ in range(40):
        time.sleep(1)
        if capcut_running():
            return True
    return False

def wait_export_done(timeout=600):
    before = set(glob.glob(os.path.join(VIDEO_OUT, '*.mp4')))
    start  = time.time()
    while time.time() - start < timeout:
        time.sleep(3)
        after = set(glob.glob(os.path.join(VIDEO_OUT, '*.mp4')))
        new   = after - before
        if new:
            fpath = list(new)[0]
            prev  = -1
            for _ in range(15):
                time.sleep(2)
                sz = os.path.getsize(fpath)
                if sz == prev and sz > 0:
                    return fpath
                prev = sz
    return None

def notify_linux(post_id, status, message=''):
    try:
        requests.post(f'{LINUX_URL}/api/capcut-render-status',
                      json={'postId': post_id, 'status': status, 'message': message},
                      timeout=10)
    except: pass

def send_file_to_linux(file_path, post_id, project_name):
    try:
        with open(file_path, 'rb') as f:
            r = requests.post(
                f'{LINUX_URL}/api/capcut-render-done',
                files={'video': (os.path.basename(file_path), f, 'video/mp4')},
                data={'postId': post_id, 'projectName': project_name},
                timeout=300)
        return r.status_code == 200
    except Exception as e:
        set_status(f'Upload error: {e}')
        return False

# ── uiautomation helpers ──────────────────────────────────────────────────────
def find_capcut_window():
    try:
        win = auto.WindowControl(searchDepth=1, Name='CapCut')
        if win.Exists(3): return win
        win = auto.WindowControl(searchDepth=1, ClassName='CapCut')
        if win.Exists(3): return win
    except Exception as e:
        print(f'[Agent] find_window error: {e}')
    return None

def click_project_by_name(project_name, win):
    try:
        short = project_name[:10]
        item = win.ListItemControl(searchDepth=10, SubName=short)
        if item.Exists(5):
            item.DoubleClick()
            return True
        item = win.Control(searchDepth=10, SubName=short)
        if item.Exists(5):
            item.DoubleClick()
            return True
    except Exception as e:
        print(f'[Agent] click_project error: {e}')
    return False

def click_export_button(win):
    try:
        btn = win.ButtonControl(searchDepth=10, Name='Export')
        if btn.Exists(5):
            btn.Click()
            return True
    except Exception as e:
        print(f'[Agent] Export button error: {e}')
    pyautogui.click(1770, 12)
    return True

def click_export_confirm():
    try:
        dialog = auto.WindowControl(searchDepth=2, SubName='Export')
        if dialog.Exists(5):
            btn = dialog.ButtonControl(searchDepth=5, Name='Export')
            if not btn.Exists(3):
                btn = dialog.ButtonControl(searchDepth=5, SubName='Export')
            if btn.Exists(3):
                btn.Click()
                return True
    except Exception as e:
        print(f'[Agent] Export confirm error: {e}')
    pyautogui.click(1187, 812)
    return True

# ── render flow ───────────────────────────────────────────────────────────────
def do_render(draft_id, project_name, post_id, zip_url):
    # Phải init COM trước khi dùng uiautomation trong thread
    uia_init = auto.UIAutomationInitializerInThread()
    if _icon: _icon.icon = make_icon('yellow')
    try:
        # 1. Tải zip
        set_status('Downloading zip...')
        zip_path = os.path.join(os.environ.get('TEMP', '.'), 'capcut_render.zip')
        r = requests.get(zip_url, stream=True, timeout=120)
        with open(zip_path, 'wb') as f:
            for chunk in r.iter_content(8192): f.write(chunk)

        # 2. Install
        set_status('Installing project...')
        if not os.path.exists(DRAFT_ROOT): os.makedirs(DRAFT_ROOT)
        with zipfile.ZipFile(zip_path, 'r') as zf: zf.extractall(DRAFT_ROOT)
        os.remove(zip_path)

        # 3. Mở CapCut
        set_status('Starting CapCut...')
        if capcut_running(): kill_capcut()
        if not open_capcut(): raise Exception('CapCut failed to start')
        time.sleep(8)  # chờ home screen

        # 4. Focus và đóng màn hình trắng nếu có
        focus_capcut()
        pyautogui.hotkey('win', 'up')
        time.sleep(2)
        pyautogui.click(1890, 20)  # đóng màn hình trắng nếu có
        time.sleep(2)

        # 5. Tìm và mở project bằng uiautomation
        set_status('Opening project...')
        win = find_capcut_window()
        opened = False
        if win:
            opened = click_project_by_name(project_name, win)

        if not opened:
            # Fallback tọa độ
            print('[Agent] Fallback to coordinates')
            pyautogui.doubleClick(300, 600)

        # 6. Chờ timeline load
        set_status('Loading timeline...')
        time.sleep(15)
        focus_capcut()
        time.sleep(2)

        # 7. Click Export
        set_status('Clicking Export...')
        win = find_capcut_window()
        if win:
            click_export_button(win)
        else:
            pyautogui.click(1770, 12)
        time.sleep(3)

        # 8. Confirm export dialog
        set_status('Confirming export...')
        click_export_confirm()

        # 9. Chờ file
        set_status('Exporting...')
        output = wait_export_done(timeout=600)
        if not output: raise Exception('Export timeout')

        # 10. Upload
        set_status('Uploading...')
        send_file_to_linux(output, post_id, project_name)
        notify_linux(post_id, 'done', output)
        kill_capcut()

        set_status('Done ✓')
        if _icon: _icon.icon = make_icon('green')

    except Exception as e:
        set_status(f'Error: {e}')
        notify_linux(post_id, 'error', str(e))
        kill_capcut()
        if _icon: _icon.icon = make_icon('red')

# ── Flask routes ──────────────────────────────────────────────────────────────
@app.route('/status')
def api_status():
    return jsonify({'ok': True, 'status': _status, 'capcut_running': capcut_running()})

@app.route('/screenshot')
def api_screenshot():
    img = pyautogui.screenshot()
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    w, h = pyautogui.size()
    return jsonify({'ok': True, 'width': w, 'height': h,
                    'image': base64.b64encode(buf.getvalue()).decode()})

@app.route('/click', methods=['POST'])
def api_click():
    d = request.json
    pyautogui.click(d['x'], d['y'])
    return jsonify({'ok': True})

@app.route('/render', methods=['POST'])
def api_render():
    d = request.json or {}
    if not d.get('draftId') or not d.get('zipUrl'):
        return jsonify({'error': 'Missing draftId or zipUrl'}), 400
    t = threading.Thread(target=do_render,
                         args=(d['draftId'], d.get('projectName', d['draftId']),
                               d.get('postId'), d['zipUrl']))
    t.daemon = True
    t.start()
    return jsonify({'ok': True, 'message': 'Render started'})

def run_flask():
    app.run(host='0.0.0.0', port=PORT, use_reloader=False)

# ── Tray ──────────────────────────────────────────────────────────────────────
def on_quit(icon, item):
    icon.stop()
    os._exit(0)

def on_status(icon, item):
    threading.Thread(target=lambda: ctypes.windll.user32.MessageBoxW(
        0, _status, 'CapCut Agent', 0), daemon=True).start()

def main():
    global _icon
    threading.Thread(target=run_flask, daemon=True).start()
    print(f'[Agent] Flask on :{PORT}')
    menu = pystray.Menu(
        pystray.MenuItem('Status', on_status),
        pystray.MenuItem('Quit',   on_quit),
    )
    _icon = pystray.Icon('CapCut Agent', make_icon('green'),
                         f'CapCut Agent — {_status}', menu)
    _icon.run()

if __name__ == '__main__':
    main()
