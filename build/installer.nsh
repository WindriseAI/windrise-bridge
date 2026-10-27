; Windrise Bridge 安装器自定义脚本
; 数据保存在安装目录下的 data\ 里（登录态、令牌、设置、自定义工具）。
; 覆盖安装 / 升级 / 卸载时，electron-builder 默认会整个删掉安装目录 ——
; 这里改成「删除除 data 之外的所有文件」，让用户数据跨版本保留。

!macro customRemoveFiles
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  wr_loop:
    StrCmp $R1 "" wr_done
    StrCmp $R1 "." wr_next
    StrCmp $R1 ".." wr_next
    StrCmp $R1 "data" wr_next
    IfFileExists "$INSTDIR\$R1\*.*" 0 +3
      RMDir /r "$INSTDIR\$R1"
      Goto wr_next
    Delete "$INSTDIR\$R1"
  wr_next:
    FindNext $R0 $R1
    Goto wr_loop
  wr_done:
  FindClose $R0
  ; 只有目录为空（data 不存在）时才会删掉安装目录本身
  RMDir "$INSTDIR"
!macroend

; 卸载时去掉开机自启（新旧两个值名），不然卸载后开机会弹「找不到程序」
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "WindriseBridge"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "BridgeReplica"
!macroend

; ---------------------------------------------------------------------------
; 随包安装浏览器内核（Windrise 浏览器，Chromium mini_installer）
;
; 为什么这么做：
;   - 浏览器安装包只进 NSIS 安装包，不进便携版，也不解压到安装目录；
;   - 安装时临时解到 $PLUGINSDIR，装完就删，安装目录里不留 160 MB 的安装器；
;   - 已经装过浏览器的机器直接跳过，不覆盖用户正在用的版本；
;     新版本装在 %LOCALAPPDATA%\Windrise，老用户机器上可能还是 %LOCALAPPDATA%\BrowserOS，
;     两个位置都算「已装」。
;   - 浏览器装失败不影响 Windrise Bridge 本体，重跑安装包即可补装。
;
; 文件从哪来：打包前运行 scripts/prepare-browser-installer.mjs，把官方
; mini_installer 放到 build/browser/windrise-browser-setup.exe。
; electron-builder 编译 NSIS 时会定义 BUILD_RESOURCES_DIR（指向 build/），
; 所以这里用绝对路径引用，不依赖 makensis 的当前目录。
; ---------------------------------------------------------------------------

!define WINDRISE_BROWSER_SETUP "${BUILD_RESOURCES_DIR}\browser\windrise-browser-setup.exe"

; 编译安装包时如果没带浏览器安装器，直接报错，别悄悄出一个缺浏览器的包。
; 编译卸载器（BUILD_UNINSTALLER）时不检查，因为那条流程不会插入 customInstall。
!ifndef BUILD_UNINSTALLER
  !if /FileExists "${WINDRISE_BROWSER_SETUP}"
  !else
    !error "找不到浏览器安装包 ${WINDRISE_BROWSER_SETUP}。先运行 node scripts/prepare-browser-installer.mjs <浏览器安装包路径>"
  !endif
!endif

; 查找已经装好的浏览器，结果放进 $R0（空 = 没装）。
; 路径和顺序必须和 electron/browseros-engine.cjs 的 executableCandidates 一致：
;   新版本（先看）：
;   - %LOCALAPPDATA%\Windrise\Application
;   - %LOCALAPPDATA%\Programs\Windrise\Application
;   - %PROGRAMFILES64%\Windrise\Application（64 位系统的 C:\Program Files）
;   老版本（回退）：
;   - %LOCALAPPDATA%\BrowserOS\Application
;   - %LOCALAPPDATA%\Programs\BrowserOS\Application
;   - %PROGRAMFILES64%\BrowserOS\Application
; 这里不看 $PROGRAMFILES：NSIS 是 32 位程序，它指向 Program Files (x86)，
; 而 64 位的 Bridge 不会去那里找；看错地方会误判成「已装」然后跳过。
!macro wrFindBrowser
  StrCpy $R0 ""
  ${If} ${FileExists} "$LOCALAPPDATA\Windrise\Application\chrome.exe"
    StrCpy $R0 "$LOCALAPPDATA\Windrise\Application"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\Programs\Windrise\Application\chrome.exe"
    StrCpy $R0 "$LOCALAPPDATA\Programs\Windrise\Application"
  ${ElseIf} ${FileExists} "$PROGRAMFILES64\Windrise\Application\chrome.exe"
    StrCpy $R0 "$PROGRAMFILES64\Windrise\Application"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\BrowserOS\Application\chrome.exe"
    StrCpy $R0 "$LOCALAPPDATA\BrowserOS\Application"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\Programs\BrowserOS\Application\chrome.exe"
    StrCpy $R0 "$LOCALAPPDATA\Programs\BrowserOS\Application"
  ${ElseIf} ${FileExists} "$PROGRAMFILES64\BrowserOS\Application\chrome.exe"
    StrCpy $R0 "$PROGRAMFILES64\BrowserOS\Application"
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro wrFindBrowser

  ${If} $R0 != ""
    DetailPrint "已安装 Windrise 浏览器：$R0，跳过"
  ${Else}
    DetailPrint "正在安装 Windrise 浏览器……"
    Push $OUTDIR
    SetOutPath "$PLUGINSDIR"
    File /oname=windrise-browser-setup.exe "${WINDRISE_BROWSER_SETUP}"
    ClearErrors
    ; --silent：Windrise 浏览器的 setup 打过补丁，认这个开关就不弹安装界面
    ;            （上游 chromium_patches/chrome/installer/setup/setup_main.cc）；
    ; --do-not-launch-chrome：装完不自动打开浏览器，留给老版 Chromium 安装器。
    ExecWait '"$PLUGINSDIR\windrise-browser-setup.exe" --silent --do-not-launch-chrome' $R1
    ${If} ${Errors}
      StrCpy $R2 "启动安装程序失败"
    ${Else}
      StrCpy $R2 ""
    ${EndIf}
    Delete "$PLUGINSDIR\windrise-browser-setup.exe"
    Pop $OUTDIR

    ; 不看退出码，直接看 chrome.exe 在不在：Chromium 安装器的成功码不止 0
    ; （重装/升级/已有更高版本都会返回非 0），但装完一定会有 chrome.exe。
    !insertmacro wrFindBrowser

    ${If} $R0 != ""
      DetailPrint "Windrise 浏览器安装完成：$R0"
    ${Else}
      ${If} $R2 == ""
        StrCpy $R2 "安装程序退出码 $R1，但没找到 chrome.exe"
      ${EndIf}
      DetailPrint "Windrise 浏览器没装上：$R2"
      ${IfNot} ${Silent}
        MessageBox MB_ICONEXCLAMATION|MB_OK "Windrise 浏览器没有安装成功（$R2）。$\r$\n$\r$\nWindrise Bridge 仍可使用；之后重新运行安装包即可补装（安装包里带着浏览器安装器）。"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
