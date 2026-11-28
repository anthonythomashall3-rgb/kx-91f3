# LOCKqz Windows blocking engine (strong v1).  Run elevated (admin).
#   powershell -ExecutionPolicy Bypass -File .\lockqz.ps1 lock|unlock|status
# Blackholes AI + DoH domains in the hosts file (all browsers + apps using system
# DNS), adds firewall backup rules, kills AI apps, and (via browser-policy.ps1) turns off
# browser AI, AI search answers, extensions and Windows Copilot/Recall for the quiz only.
# Fully reversible: browser-policy.ps1 backs up every policy value it changes and puts the
# student's (or their organisation's) own values back at unlock.
# Output contract (read by lockqzd.ps1): the LAST line starts with
#   "LOCKqz: LOCKED"      - the hosts block is really in place
#   "LOCKqz: LOCK FAILED" - it is not (e.g. hosts file not writable)
#   "LOCKqz: UNLOCKED"    - the hosts block is really gone
#   "LOCKqz: UNLOCK FAILED"
param([Parameter(Mandatory=$true)][ValidateSet("lock","unlock","status","warm","test")]$cmd)
# "test" = the helper's "Test it now" (at most 2 minutes, outside any quiz): the same AI block, but virtual
# machines, remote-control tools and VPNs are left running (a quiz closes them; a test must not cut off the
# computer it runs on). "unlock" removes either.
$TestMode = ($cmd -eq "test")
$ErrorActionPreference = "SilentlyContinue"

$Hosts     = "$env:WINDIR\System32\drivers\etc\hosts"
$StateDir  = "$env:ProgramData\LOCKqz"
$Backup    = "$StateDir\hosts.backup"
$MarkStart = "# LOCKqz START - do not edit"
$MarkEnd   = "# LOCKqz END"
$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$BlockFile = Join-Path $Here "blocklist.txt"
$Policy    = Join-Path $Here "browser-policy.ps1"
# (no "dia": that name is also the Dia diagram editor; M365Copilot = the Microsoft 365 Copilot app)
$AiApps = @("chatgpt","claude","copilot","perplexity","ollama","lmstudio","LM Studio","gpt4all","msty","cluely","jan","comet","atlas","notion ai","deepseek","poe","mistral","sider","grammarly",
            "AnythingLLM","Chatbox","Cherry Studio","M365Copilot","AIDevGallery",
            # local-model chat apps (their servers: $ModelProcs)
            "Msty Studio","Backyard AI","Faraday","Sanctum","Open WebUI","Pinokio","Witsy","Reor","ollama app",
            "grok","kimi","qwen",   # xAI / Kimi / Qwen desktop apps
            "codex","doubao","quillbot","highlight","fellou","browseros","raycast",
            "Wispr Flow","superwhisper","OpenWhispr","Aqua Voice","Aqua","Willow","Willow Voice","BossAI","Granola","Limitless","LobeHub","LobeChat",   # AI writing by voice with answer modes, meeting assistants with an Ask AI chat, a chat app
            "Notion","Notion Mail","Notion Calendar","Canva","slack","Evernote","GoodNotes",
            "WhatsApp","Telegram","Discord","Messenger")   # messaging apps whose AI bots cannot be separated (Meta AI, Telegram/Discord bots; owner, 28 Oct). OpenAI Codex, Doubao, QuillBot, Highlight AI, AI browsers, Raycast AI
# Non-browser routes to AI or a human helper, all closed during the quiz:
$VmApps     = @("Parallels","prl_vm_app","vmware","vmware-vmx","VirtualBox","VirtualBoxVM","VBoxHeadless","qemu-system-x86_64","qemu-system-aarch64","vmwp","vmms","Docker Desktop","com.docker.backend",
                "WindowsSandbox","WindowsSandboxClient","WindowsSandboxServer","WindowsSandboxRemoteSession","wsl","wslhost","wslrelay",
                "multipassd","podman","Podman Desktop","Rancher Desktop",
                # Android emulators (an Android AI app with its own network on the PC screen)
                "HD-Player","Bluestacks","BlueStacksX","Nox","NoxVMHandle","dnplayer","LdVBoxHeadless","MEmu","MEmuHeadless","MuMuPlayer","MuMuVMMHeadless","genymotion")
$RemoteApps = @("TeamViewer","AnyDesk","RustDesk","remoting_host","ScreenConnect","ConnectWiseControl","LogMeIn","Splashtop","SRServer","vncserver","winvnc","tvnserver","Parsec","GoToMyPC",
                "mstsc","msrdc","QuickAssist",
                "PhoneExperienceHost","nxplayer","ZohoAssist",
                "scrcpy","escrcpy","QtScrcpy","Vysor","AirDroid","ApowerMirror","LetsView","AirServer","AnyViewer",
                "Moonlight","vncviewer","RealVNC","Shadow","wfica32","CDViewer","SelfService","vmware-view","workspaces","RDCMan","RemoteDesktopManager","mRemoteNG","RoyalTS",
                "ssh","putty","kitty","MobaXterm","Termius","SecureCRT","mosh-client")   # Phone Link = the phone's apps (and its network) on the PC screen; NoMachine; Zoho Assist; ssh / PuTTY / Termius = a shell on another computer
$OverlayApps= @("Cluely","InterviewCoder","Interview Coder","LockedInAI","FinalRound","Ohmni","Sensei","UltraCode","Pieces","Verve AI","Parakeet AI","Beyz AI","Interview Solver",
                "SubcueAI","Subcue","CTRLpotato","ClapAssist","Offerin","LastRound","LastRound AI","Linkjob","Linkjob AI","Craqly",
                "SigMeet","Aissence","CamCue","GhostPilot","GhostPilot AI","Glimp","GhostDesk","Wittro","KlewAI","GhostInterview",
                "Ofradr","Pluely","Natively","OpenCluely","Cheating Daddy","cheating-daddy","xexamai","MindWhisper","MindWhisper AI",
                "HackySack","Juxano","OfferBull","Coadeo","ExtraBrain","Cuebird","TechScreen","Shadecoder","Intrvw","InvisibleAI",
                "PhantomDesk","PhantomDesk AI","InterviewBee","Ghostcoder","Interview Copilot")
$ModelProcs = @("ollama","llama-server","llama-cli","llama-run","llamafile","koboldcpp","localai","local-ai","jan","gpt4all","text-generation-webui","vllm",
                "ollama_llama_server","lms","llama-mtmd-cli","koboldcpp_cu12","koboldcpp_nocuda","cortex","cortex-server","open-webui","lmdeploy","text-generation-launcher","lemonade-server","lemonade-app","foundry","Inference.Service.Agent")
# tor = the Tor Browser's network daemon (Tor resolves names remotely, past the hosts block).
$VpnApps    = @("nordvpn","expressvpn","surfshark","protonvpn","mullvad","pia","piaservice","Cloudflare WARP","warp-svc","openvpn","wireguard","windscribe","tunnelbear","hssvpn","cyberghost","tor",
                # proxies and tunnels that look names up remotely (past the hosts block), Tailscale / ZeroTier networks
                "Proxifier","psiphon3","lantern","hiddify","nekoray","v2rayN","v2ray","xray","sing-box","clash-verge","Clash for Windows","mihomo","hysteria","naive","sslocal","ss-local","Shadowsocks",
                "cloudflared","ngrok","frpc","chisel","tailscale-ipn","tailscaled","zerotier_desktop_ui","zerotier-one_x64","obfs4proxy","lyrebird","snowflake-client")
$ModelPorts = @(11434,1234,4891,1337,7860)
# 8080/8000/5000 are also ordinary web ports: blocked only to private networks (where a llama.cpp / vLLM
# server would run), never to the internet. No loopback address in the list: Windows Firewall refuses a rule
# that names one (the whole rule would not be made), and a model server on this PC itself is closed as a
# program ($ModelProcs).
$LocalModelPorts = @(8080,5000,8000)
$LocalNets  = @("10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","169.254.0.0/16","fc00::/7","fe80::/10")
$VpnPorts   = @(51820,1194,500,4500)
# Encrypted-DNS resolvers a browser may already be connected to (IPv4 + IPv6), incl. the
# Firefox (mozilla.cloudflare-dns.com) and Chrome (chrome.cloudflare-dns.com) endpoints.
$DohIps = @("1.1.1.1","1.0.0.1","8.8.8.8","8.8.4.4","9.9.9.9","149.112.112.112",
            "162.159.61.3","162.159.61.4","172.64.41.3","172.64.41.4","146.112.41.2",
            "2606:4700:4700::1111","2606:4700:4700::1001","2001:4860:4860::8888","2001:4860:4860::8844",
            "2620:fe::fe","2620:fe::9","2803:f800:53::3","2803:f800:53::4","2a06:98c1:52::3","2a06:98c1:52::4",
            "2620:119:fc::2",
            # AdGuard, Mullvad, Control D, CIRA Shield, Wikimedia DNS, AliDNS, DNSPod (doh.pub)
            "94.140.14.14","94.140.15.15","2a10:50c0::ad1:ff","2a10:50c0::ad2:ff","194.242.2.2","2a07:e340::2",
            "76.76.2.11","2606:1a40::11","149.112.121.10","149.112.122.10","2620:10a:80bb::10","2620:10a:80bc::10",
            "185.71.138.138","2001:67c:930::1","223.5.5.5","223.6.6.6","2400:3200::1","2400:3200:baba::1",
            "1.12.12.12","120.53.53.53",
            # 29 Oct 2026: NextDNS, CleanBrowsing, OpenDNS, dns.sb, Control D ranges, Quad101, dns0.eu, Quad9 variants, Yandex
            "45.90.28.0/22","185.228.168.0/23","208.67.222.222","208.67.220.220","208.67.222.123","208.67.220.123","185.222.222.222","45.11.45.11","101.101.101.101","101.102.103.104",
            "193.110.81.0","185.253.5.0","9.9.9.10","9.9.9.11","149.112.112.10","149.112.112.11","76.76.2.0/24","76.76.10.0/24","94.140.14.0/23","77.88.8.8","77.88.8.1",
            "2a07:a8c0::/32","2a07:a8c1::/32","2a0d:2a00:1::/48","2a0d:2a00:2::/48","2620:119:35::35","2620:119:53::53","2620:fe::10","2620:fe::11","2620:fe::fe:10","2620:fe::fe:11","2a10:50c0::/29")
$FwTag  = "LOCKqz-AI"
$FwRules = @(
  @{ n = "$FwTag-DoT";     p = @{ Protocol = "TCP"; RemotePort = 853 } },
  @{ n = "$FwTag-DoQ";     p = @{ Protocol = "UDP"; RemotePort = 853 } },
  @{ n = "$FwTag-DoH";     p = @{ Protocol = "TCP"; RemotePort = 443; RemoteAddress = $DohIps } },
  @{ n = "$FwTag-DoH3";    p = @{ Protocol = "UDP"; RemotePort = 443; RemoteAddress = $DohIps } },
  @{ n = "$FwTag-models";  p = @{ Protocol = "TCP"; RemotePort = $ModelPorts } },
  @{ n = "$FwTag-models-local"; p = @{ Protocol = "TCP"; RemotePort = $LocalModelPorts; RemoteAddress = $LocalNets } },
  @{ n = "$FwTag-vpn-udp"; p = @{ Protocol = "UDP"; RemotePort = $VpnPorts } },
  @{ n = "$FwTag-vpn-tcp"; p = @{ Protocol = "TCP"; RemotePort = 1194 } },
  @{ n = "$FwTag-vpn-ssh"; p = @{ Protocol = "TCP"; RemotePort = 22 } }   # a shell on another computer (SSH under any program name)
)
# Wildcard AI domains (28 Oct 2026): the hosts file cannot block a whole domain, so a per-customer AI
# endpoint (<name>.openai.azure.com, a chat proxy on *.workers.dev / *.hf.space / *.vercel.app, a
# tunnel to a model at home) used by a CLI or desktop app stayed open. While locked, one NRPT rule per
# domain sends every name under it to 127.0.0.1, where nothing answers: the lookup fails at once for
# every program that uses Windows DNS. Browsers never needed this (their policies block the subdomains).
# Never pages.dev (LOCKqz itself lives there). Same list as app/mac/extra-block.sh WILD_DOMAINS.
$WildDomains = @("openai.azure.com","cognitiveservices.azure.com","services.ai.azure.com","inference.ai.azure.com","ai.azure.com",
                 "workers.dev","hf.space","modal.run","vercel.app","fly.dev","replit.dev","replit.app","repl.co",
                 "ngrok.io","ngrok-free.app","ngrok.app","ngrok.dev","ngrok-free.dev","trycloudflare.com","loca.lt","serveo.net",
                 "localhost.run","pinggy.link","pinggy.io","zrok.io","learnwise.ai","forethought.ai",
                 "translate.goog","github.dev","gitpod.io","csb.app","mybinder.org","devtunnels.ms","gradio.live","val.run","streamlit.app","dash.ai")
$WildTag = "LOCKqz-wild"
# Warm connections (28 Oct 2026): an app LOCKqz does not close (Office, a PDF reader ...) that already
# held an open keep-alive connection to an AI host when the quiz opened could keep using it: the hosts
# file only stops NEW name lookups. "warm" resolves the blocklist's hosts (past the hosts file) into
# $WarmFile in the background (at most every 12 h); each lock pass kills every established IPv4 TCP
# connection to one of those addresses (SetTcpEntry, once per list version) and blocks QUIC (UDP 443)
# to them so browsers fall back to TCP. New TCP connections still pass: a shared CDN address also
# serves Brightspace/LOCKqz, and a new connection needs a name lookup, which the hosts block refuses.
$WarmFile = "$StateDir\warm_ips.txt"
# API-only AI endpoints (29 Oct 2026): dropped outright on 443 (new connections too) - a client that never asks DNS
# (curl --resolve, hard-coded address, own DoH) gets nothing. Never Google/Microsoft/GitHub front doors (shared with
# Docs/Office/GitHub); any address an allow host (Brightspace, LOCKqz, sign-in) also uses is left alone.
$ApiHosts = @("api.openai.com","api.anthropic.com","api.x.ai","api.deepseek.com","api.mistral.ai","api.groq.com","openrouter.ai","api.together.xyz","api.together.ai","api.perplexity.ai","api.cohere.com","api.cohere.ai","api.fireworks.ai","api.replicate.com","router.huggingface.co","api-inference.huggingface.co","api.cerebras.ai","api.sambanova.ai","api.deepinfra.com","api.hyperbolic.xyz","api.novita.ai","api.moonshot.cn","api.moonshot.ai","open.bigmodel.cn","api.minimax.chat","api.minimaxi.com","api.ai21.com","api.voyageai.com","api.siliconflow.cn","api.siliconflow.com","api.lepton.ai","api.baseten.co","api.friendli.ai","api.nebius.com","api.studio.nebius.ai","api.kimi.com")
$AllowHosts = @("lockqz.pages.dev","lockqz.com","www.lockqz.com","professor.lockqz.com","usc.brightspace.com","brightspace.com","s.brightspace.com","content-cdn.brightspace.com","d2l.com","www.d2l.com","lms.usc.edu","google.com","www.google.com","docs.google.com","drive.google.com","accounts.google.com","login.microsoftonline.com","outlook.office.com","www.office.com","shibboleth.usc.edu","my.usc.edu","www.usc.edu","cloudflare.com","challenges.cloudflare.com","static.cloudflareinsights.com")
$ApiFile = "$StateDir\api_ips.txt"
$WarmMaxAge = 43200
# Latin-1 maps every byte to one char and back, so a hosts file in any encoding round-trips untouched.
$Latin1 = [Text.Encoding]::GetEncoding(28591)

function Get-Domains {
  Get-Content $BlockFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") }
}
# Exam rules (27 Nov 2026): what the professor lets students use in this exam. lockqzd.ps1 writes rules.json (this
# admin-only folder) from the server's answer; Build-Exam turns it and rules-catalog.json (the Mac's file) into this
# exam's lists: exam-blocklist.txt in place of blocklist.txt (hosts file; browser-policy.ps1 reads it too),
# exam-apps.txt (programs closed / kept open / typed by the professor), exam.json (browser policy). No rules, or rules
# that cannot be read: LOCKqz locks exactly as without them.
$RulesFile = if ($env:LOCKQZ_RULES) { $env:LOCKQZ_RULES } else { "$StateDir\rules.json" }
$ExamDir   = if ($env:LOCKQZ_EXAM_DIR) { $env:LOCKQZ_EXAM_DIR } else { $StateDir }
$Catalog   = Join-Path $Here "rules-catalog.json"
$ExamApps  = @()
function LQ-Host([string]$v) {
  # A site typed by the professor -> its host ("https://www.x.com/a" -> "x.com"), "" when it is not a site.
  $s = ($v.Trim().ToLower() -replace '^[a-z][a-z0-9+.-]*://', '')
  $s = (($s -split '[/?#]', 2)[0] -replace ':\d+$', '').TrimEnd('.')
  if ($s.StartsWith("www.")) { $s = $s.Substring(4) }
  if (($s.Length -le 100) -and ($s -cmatch '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+$')) { return $s }
  return ""
}
function LQ-Under([string]$h, [string]$d) { return (($h -eq $d) -or $h.EndsWith("." + $d)) }
function Build-Exam([string]$rulesFile, [string]$blockFile, [string]$catalogFile) {
  # -> @{ list; apps; exam } for this exam, $null when the rules or the catalog cannot be read. Same result as
  # app/mac/rules.py build: an allowed row's own entries leave the list (no other entry ever does), a blocked row's
  # entries and the professor's blocked sites join it (never Brightspace, sign-in or LOCKqz).
  try { $cat = Get-Content -LiteralPath $catalogFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
  try { $rec = Get-Content -LiteralPath $rulesFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
  if ((-not $cat) -or (-not $cat.rows) -or (-not $rec)) { return $null }
  $r = $rec; if ($rec.rules) { $r = $rec.rules }
  if ($null -eq $r.b) { return $null }
  $keys = @($cat.rows.PSObject.Properties | ForEach-Object { $_.Name })
  $b = @{}; foreach ($k in @($r.b)) { if ($keys -ccontains [string]$k) { $b[[string]$k] = $true } }
  $allowed = @($keys | Where-Object { -not $b.ContainsKey($_) }); $blocked = @($keys | Where-Object { $b.ContainsKey($_) })
  $row = { param($k, $f) @(@($cat.rows.$k.$f) | Where-Object { $_ } | ForEach-Object { [string]$_ }) }
  $gone = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($k in $allowed) { foreach ($e in @(& $row $k "hosts") + @(& $row $k "paths")) { [void]$gone.Add($e.ToLower()) } }
  $have = New-Object 'System.Collections.Generic.HashSet[string]'
  $list = New-Object System.Collections.ArrayList
  foreach ($l in [IO.File]::ReadAllLines($blockFile)) { $e = $l.Trim().ToLower(); if ($e -and -not $e.StartsWith("#") -and -not $e.Contains(" ") -and -not $gone.Contains($e) -and $have.Add($e)) { [void]$list.Add($e) } }
  $add = New-Object System.Collections.ArrayList
  foreach ($k in $blocked) { foreach ($e in @(& $row $k "hosts") + @(& $row $k "paths")) { [void]$add.Add($e.ToLower()) } }
  if ($b.ContainsKey("search")) { foreach ($e in @($cat.search_hosts)) { [void]$add.Add(([string]$e).ToLower()) } }
  # never the exam (its own site too, whatever the Brightspace of the school is called), sign-in or LOCKqz
  $keepSites = @(@($cat.base_allow) | ForEach-Object { ([string]$_).Split("/")[0] })
  $qh0 = [string]$rec.quiz_host; if ($qh0 -cmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+$') { $keepSites += $qh0 }
  $typedIn = @(@($r.block) | Where-Object { $_ -is [string] } | Select-Object -First 20)
  foreach ($x in $typedIn) {
    $h = ""; if ($x -notmatch '\.exe$') { $h = LQ-Host $x }
    if ($h -and -not @($keepSites | Where-Object { (LQ-Under $_ $h) -or (LQ-Under $h $_) }).Count) { [void]$add.Add($h) }
  }
  foreach ($e in $add) { if ((($e -cmatch '^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z][a-z0-9-]+$') -or ($e -cmatch '^[a-z0-9.-]+\.[a-z]{2,}/[a-z0-9._~%/-]*$')) -and $have.Add($e)) { [void]$list.Add($e) } }
  $never = @(@($cat.never_close) | ForEach-Object { ([string]$_).ToLower() })
  $apps = New-Object System.Collections.ArrayList
  foreach ($k in $blocked) { foreach ($n in @(& $row $k "win")) { [void]$apps.Add(@("close", $n)) } }
  foreach ($k in $allowed) { foreach ($n in @(& $row $k "win")) { [void]$apps.Add(@("keep", $n)) } }
  foreach ($x in $typedIn) {
    $n = $x; if ($x -match '\.(app|exe)$') { $n = $x -replace '\.(app|exe)$', '' } elseif (LQ-Host $x) { continue }
    if (($n -cmatch "^[A-Za-z0-9][A-Za-z0-9 ._&+()'-]{0,59}$") -and ($never -notcontains $n.ToLower())) { [void]$apps.Add(@("typed", $n)) }
  }
  $web = $null
  if ($b.ContainsKey("web")) {
    $bh = @($list | Where-Object { -not $_.Contains("/") })
    $allowIn = @(@($r.allow) | Where-Object { $_ -is [string] } | ForEach-Object { LQ-Host $_ } | Where-Object { $_ } | Select-Object -First 20)
    $web = New-Object System.Collections.ArrayList
    $cand = @(@($cat.base_allow) | ForEach-Object { [string]$_ })
    foreach ($k in $allowed) { $cand += @(& $row $k "hosts") + @(& $row $k "paths") + @(& $row $k "web") }
    $qh = [string]$rec.quiz_host; if ($qh -cmatch '^[a-z0-9-]+(\.[a-z0-9-]+)+$') { $cand += $qh }
    foreach ($e in (@($cand) + @($allowIn))) {
      $e = $e.ToLower(); if ($web -contains $e) { continue }
      if (($allowIn -contains $e) -and @($bh | Where-Object { LQ-Under ($e.Split("/")[0]) $_ }).Count) { continue }   # a typed site never opens a blocked one
      [void]$web.Add($e)
    }
  }
  $lbl = [string]$r.label; if ($lbl.Length -gt 40) { $lbl = $lbl.Substring(0, 40) }
  $exam = [ordered]@{ v = 1; label = $lbl; b = [object[]]@($blocked | Sort-Object); web = $null; search = (-not $b.ContainsKey("search")); translate = (-not $b.ContainsKey("translate")) }
  if ($null -ne $web) { $exam["web"] = [object[]]@($web) }
  return @{ list = @($list); apps = @($apps); exam = $exam }
}
function LQ-WriteIfChanged([string]$path, [string]$text) {
  $cur = $null; try { $cur = [IO.File]::ReadAllText($path) } catch { }
  if ($cur -ne $text) { [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false))) }
}
function Use-Exam {
  # This exam's lists from the professor's rules (written only when they changed), before every layer reads them;
  # none: the exam files go and LOCKqz locks as always.
  $f = @("exam.json", "exam-blocklist.txt", "exam-apps.txt") | ForEach-Object { Join-Path $ExamDir $_ }
  $e = $null; if (Test-Path -LiteralPath $RulesFile) { $e = Build-Exam $RulesFile (Join-Path $Here "blocklist.txt") $Catalog }
  if (-not $e) { foreach ($x in $f) { Remove-Item -LiteralPath $x -Force -ErrorAction SilentlyContinue }; return }
  try {
    LQ-WriteIfChanged $f[1] ((@($e.list) -join "`n") + "`n")
    LQ-WriteIfChanged $f[2] ((@($e.apps | ForEach-Object { $_[0] + "`t" + $_[1] }) -join "`n") + "`n")
    LQ-WriteIfChanged $f[0] ($e.exam | ConvertTo-Json -Compress -Depth 4)
    $script:BlockFile = $f[1]; $script:ExamApps = @($e.apps)
  } catch { foreach ($x in $f) { Remove-Item -LiteralPath $x -Force -ErrorAction SilentlyContinue } }
}
function Clear-Exam { foreach ($n in @("exam.json", "exam-blocklist.txt", "exam-apps.txt")) { Remove-Item -LiteralPath (Join-Path $ExamDir $n) -Force -ErrorAction SilentlyContinue } }
function Get-HostsLines($domains) {
  # A path entry (site.com/chat) can't be a hosts entry; browser-policy.ps1 blocks those URLs.
  $lines = @($MarkStart)
  foreach ($d in $domains) {
    if ($d -like "*/*") { continue }
    $lines += "0.0.0.0 $d"; $lines += ":: $d"
    if ($d -like "*.*" -and $d -notlike "www.*") { $lines += "0.0.0.0 www.$d"; $lines += ":: www.$d" }
  }
  $lines += $MarkEnd
  return $lines
}
function Remove-Block([string]$raw) {
  $raw = [regex]::Replace($raw, "(?s)\r?\n?" + [regex]::Escape($MarkStart) + ".*?" + [regex]::Escape($MarkEnd) + "\r?\n?", "")
  return ($raw.TrimEnd() + "`r`n")
}
function Read-Hosts { [IO.File]::ReadAllText($Hosts, $Latin1) }
function Is-Locked { try { (Read-Hosts) -match [regex]::Escape($MarkStart) } catch { $false } }
function Block-Intact {   # the markers are there AND every line between them is ours (an edited block is tamper)
  try {
    $raw = Read-Hosts
    $m = [regex]::Match($raw, "(?s)" + [regex]::Escape($MarkStart) + "(.*?)" + [regex]::Escape($MarkEnd))
    if (-not $m.Success) { return $false }
    $have = @($m.Groups[1].Value -split "\r?\n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    $want = @((Get-HostsLines (Get-Domains)) | Select-Object -Skip 1 | Select-Object -SkipLast 1)
    return ((Compare-Object $have $want | Measure-Object).Count -eq 0)
  } catch { return $false }
}
function Write-Hosts([string]$text, [bool]$append) {
  # Clears a read-only flag for the write and puts it back; $false if the write failed.
  $ro = $false
  try {
    $fi = Get-Item -LiteralPath $Hosts -Force -ErrorAction Stop
    $ro = $fi.IsReadOnly
    if ($ro) { $fi.IsReadOnly = $false }
    # Another program can hold the hosts file open for a moment (the DNS service re-reading it, a virus scanner
    # looking at the change just made): the write is tried again for about a second before it counts as failed.
    for ($try = 1; ; $try++) {
      try {
        if ($append) { [IO.File]::AppendAllText($Hosts, $text, $Latin1) } else { [IO.File]::WriteAllText($Hosts, $text, $Latin1) }
        return $true
      } catch [IO.IOException] { if ($try -ge 6) { $script:HostsWhy = "$($_.Exception.GetType().Name): $($_.Exception.Message)"; return $false }; Start-Sleep -Milliseconds 200 }
    }
  } catch { $script:HostsWhy = "$($_.Exception.GetType().Name): $($_.Exception.Message)"; return $false }
  finally { if ($ro) { try { (Get-Item -LiteralPath $Hosts -Force).IsReadOnly = $true } catch { } } }
}

function Kill-AiAndTools {
  $all = if ($TestMode) { $AiApps + $OverlayApps + $ModelProcs } else { $AiApps + $VmApps + $RemoteApps + $OverlayApps + $ModelProcs + $VpnApps }
  # One look at the running programs for the whole list (the lock pass repeats every few seconds during a quiz).
  $want = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $wild = @()
  foreach ($a in $all) { if ($a -match '[*?\[]') { $wild += $a } else { [void]$want.Add([string]$a) } }
  # Exam rules: the blocked rows' programs close too; an allowed row keeps its programs open (a chat app the professor
  # allows); a program the professor typed closes only when it is not one of Windows' own.
  $typed = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($x in @($ExamApps)) { if ($x[0] -eq "close") { [void]$want.Add([string]$x[1]) } elseif ($x[0] -eq "typed") { [void]$typed.Add([string]$x[1]) } }
  foreach ($x in @($ExamApps)) { if ($x[0] -eq "keep") { [void]$want.Remove([string]$x[1]) } }
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    $n = [string]$p.ProcessName; $hit = $want.Contains($n)
    if (-not $hit) { foreach ($w in $wild) { if ($n -like $w) { $hit = $true; break } } }
    if ((-not $hit) -and $typed.Contains($n)) { try { $hit = [bool]($p.Path -and ($p.Path -notlike "$env:WINDIR\*")) } catch { } }
    if ($hit) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; continue }
    # A local model under any program name: a big program (over 1 GB in memory, not a browser or Office) whose
    # command line names a model file (llama.cpp -m x.gguf, MLX / transformers weights) or whose program file is
    # itself over 1.5 GB (a llamafile).
    try {
      if ($p.WorkingSet64 -gt 1GB -and $p.Path -and ($p.Path -notlike "$env:WINDIR\*") -and ($NoModelCheck -notcontains $n)) {
        $big = $false; try { $big = ((Get-Item -LiteralPath $p.Path -ErrorAction Stop).Length -gt 1.5GB) } catch { }
        $cl = ""; if (-not $big) { $cl = [string](Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$p.Id) -ErrorAction Stop).CommandLine }
        if ($big -or ($cl -match $ModelFileRe)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
      }
    } catch { }
  }
}
$ModelFileRe = '[.](gguf|ggml|safetensors|llamafile)([^A-Za-z0-9]|$)|\\[.]ollama\\models\\|\\[.]lmstudio\\models\\|\\[.]cache\\lm-studio\\|\\huggingface\\hub\\model[s]--'
$NoModelCheck = @("chrome","msedge","firefox","brave","opera","vivaldi","explorer","dwm","svchost","MsMpEng","Memory Compression","OUTLOOK","WINWORD","EXCEL","POWERPNT","ONENOTE","ms-teams","Teams","Zoom","Code","devenv","Acrobat","AcroRd32","Photoshop")
function Ensure-FirewallRules {
  # One rule per name: creates missing ones, collapses duplicates left by an older version.
  # First a quick look at the rules where Windows keeps them (one registry key): when every LOCKqz rule is there
  # exactly once nothing more is asked. The firewall cmdlet below takes about a second, and this runs on every
  # lock pass of a quiz. Anything else (a rule missing or doubled, the key unreadable) goes on to the cmdlet.
  try {
    $rk = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey("SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules", $false)
    if ($rk) {
      $cnt = @{}
      try {
        foreach ($vn in $rk.GetValueNames()) {
          $m = [regex]::Match([string]$rk.GetValue($vn), '\|Name=([^|]*)\|')
          if ($m.Success -and $m.Groups[1].Value.StartsWith("$FwTag-")) { $cnt[$m.Groups[1].Value] = 1 + [int]$cnt[$m.Groups[1].Value] }
        }
      } finally { $rk.Close() }
      $all = $true
      foreach ($r in $FwRules) {
        if ($TestMode -and ($r.n -like "$FwTag-vpn-*")) { continue }
        if ([int]$cnt[$r.n] -ne 1) { $all = $false; break }
      }
      if ($all) { return }
    }
  } catch { }
  $have = @(Get-NetFirewallRule -DisplayName "$FwTag-*" -ErrorAction SilentlyContinue)
  foreach ($r in $FwRules) {
    if ($TestMode -and ($r.n -like "$FwTag-vpn-*")) { continue }
    $same = @($have | Where-Object { $_.DisplayName -eq $r.n })
    if ($same.Count -eq 1) { continue }
    if ($same.Count -gt 1) { $same | Remove-NetFirewallRule -ErrorAction SilentlyContinue }
    $p = $r.p
    New-NetFirewallRule -DisplayName $r.n -Direction Outbound -Action Block @p | Out-Null
  }
}
function Wild-On {
  $have = @(Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Comment -eq $WildTag } | ForEach-Object { $_.Namespace })
  foreach ($d in $WildDomains) {
    if ($d -like "*pages.dev") { continue }
    if ($have -contains ".$d") { continue }
    Add-DnsClientNrptRule -Namespace ".$d" -NameServers "127.0.0.1" -Comment $WildTag -ErrorAction SilentlyContinue | Out-Null
  }
}
function Wild-Off {
  Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Where-Object { $_.Comment -eq $WildTag } | Remove-DnsClientNrptRule -Force -ErrorAction SilentlyContinue
}
function Resolve-Set($names) {
  $ips = New-Object System.Collections.Generic.HashSet[string]
  foreach ($d in $names) {
    foreach ($t in "A","AAAA") {
      foreach ($r in (Resolve-DnsName -Name $d -Type $t -NoHostsFile -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue)) {
        $ip = [string]$r.IPAddress
        if (-not $ip) { continue }
        if ($ip -match '^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or $ip -eq '::1' -or $ip -match '^(fe80|fc|fd)') { continue }
        [void]$ips.Add($ip)
      }
    }
  }
  return $ips
}
function Warm-Resolve {   # writes $WarmFile (+ $ApiFile) atomically; runs in the background (lockqz.ps1 warm)
  $api = Resolve-Set $ApiHosts; $allow = Resolve-Set $AllowHosts
  foreach ($a in $allow) { [void]$api.Remove($a) }
  if ($api.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    [IO.File]::WriteAllLines("$ApiFile.tmp", [string[]]($api | Sort-Object)); Move-Item -Force "$ApiFile.tmp" $ApiFile
  }
  $ips = New-Object System.Collections.Generic.HashSet[string]
  foreach ($d in (Get-Domains)) {
    foreach ($t in "A","AAAA") {
      foreach ($r in (Resolve-DnsName -Name $d -Type $t -NoHostsFile -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue)) {
        $ip = [string]$r.IPAddress
        if (-not $ip) { continue }
        if ($ip -match '^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -or $ip -eq '::1' -or $ip -match '^(fe80|fc|fd)') { continue }
        [void]$ips.Add($ip)
      }
    }
  }
  if ($ips.Count -eq 0) { return }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  $tmp = "$WarmFile.tmp"
  [IO.File]::WriteAllLines($tmp, [string[]]($ips | Sort-Object))
  Move-Item -Force $tmp $WarmFile
}
function Warm-KillTcp($ips) {   # established IPv4 TCP connections to $ips -> closed (MIB_TCP_STATE_DELETE_TCB)
  if (-not ("LOCKqz.Tcp" -as [type])) {
    Add-Type -Namespace LOCKqz -Name Tcp -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)] public struct MIB_TCPROW { public int dwState; public int dwLocalAddr; public int dwLocalPort; public int dwRemoteAddr; public int dwRemotePort; }
[DllImport("iphlpapi.dll")] public static extern int SetTcpEntry(ref MIB_TCPROW row);
"@ -ErrorAction SilentlyContinue
  }
  $set = New-Object System.Collections.Generic.HashSet[string]
  foreach ($ip in $ips) { [void]$set.Add([string]$ip) }
  $n = 0
  foreach ($c in (Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)) {
    if (-not $set.Contains([string]$c.RemoteAddress)) { continue }
    if ($c.RemoteAddress -notmatch '^\d+\.\d+\.\d+\.\d+$') { continue }
    try {
      $row = New-Object LOCKqz.Tcp+MIB_TCPROW
      $row.dwState = 12
      $row.dwLocalAddr  = [BitConverter]::ToInt32(([Net.IPAddress]$c.LocalAddress).GetAddressBytes(), 0)
      $row.dwRemoteAddr = [BitConverter]::ToInt32(([Net.IPAddress]$c.RemoteAddress).GetAddressBytes(), 0)
      $row.dwLocalPort  = ((($c.LocalPort -band 0xff) -shl 8) -bor (($c.LocalPort -shr 8) -band 0xff))
      $row.dwRemotePort = ((($c.RemotePort -band 0xff) -shl 8) -bor (($c.RemotePort -shr 8) -band 0xff))
      if ([LOCKqz.Tcp]::SetTcpEntry([ref]$row) -eq 0) { $n++ }
    } catch {}
  }
  return $n
}
function Warm-Apply {
  $marker = "$StateDir\warm.applied"
  if ((Test-Path $ApiFile) -and -not (Get-NetFirewallRule -DisplayName "$FwTag-api" -ErrorAction SilentlyContinue)) {
    $aips = @(Get-Content $ApiFile -ErrorAction SilentlyContinue | Where-Object { $_ })
    if ($aips.Count -gt 0) { New-NetFirewallRule -DisplayName "$FwTag-api" -Direction Outbound -Action Block -Protocol TCP -RemotePort 443 -RemoteAddress $aips -ErrorAction SilentlyContinue | Out-Null }
  }
  if (Test-Path $WarmFile) {
    $ips = @(Get-Content $WarmFile -ErrorAction SilentlyContinue | Where-Object { $_ })
    if ($ips.Count -gt 0) {
      $fresh = (-not (Test-Path $marker)) -or ((Get-Item $WarmFile).LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc)
      if ($fresh) {
        Get-NetFirewallRule -DisplayName "$FwTag-warm-quic" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName "$FwTag-warm-quic" -Direction Outbound -Action Block -Protocol UDP -RemotePort 443 -RemoteAddress $ips -ErrorAction SilentlyContinue | Out-Null
        Warm-KillTcp $ips | Out-Null
        New-Item -ItemType File -Force -Path $marker | Out-Null
      } elseif (-not (Get-NetFirewallRule -DisplayName "$FwTag-warm-quic" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "$FwTag-warm-quic" -Direction Outbound -Action Block -Protocol UDP -RemotePort 443 -RemoteAddress $ips -ErrorAction SilentlyContinue | Out-Null
      }
    }
  }
  $stale = (-not (Test-Path $WarmFile)) -or (((Get-Date).ToUniversalTime() - (Get-Item $WarmFile).LastWriteTimeUtc).TotalSeconds -gt $WarmMaxAge)
  $busy = "$WarmFile.refreshing"
  if ($stale -and (-not (Test-Path $busy) -or ((Get-Date).ToUniversalTime() - (Get-Item $busy).LastWriteTimeUtc).TotalMinutes -gt 10)) {
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    New-Item -ItemType File -Force -Path $busy | Out-Null
    Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$($MyInvocation.ScriptName)`" warm" -ErrorAction SilentlyContinue
  }
}
function Warm-Clear {
  Remove-Item -LiteralPath "$StateDir\warm.applied" -Force -ErrorAction SilentlyContinue
}
function Policy($verb) {
  if (-not (Test-Path $Policy)) { return "" }
  return ((& powershell -NoProfile -ExecutionPolicy Bypass -File $Policy $verb) -join "`n")
}
# The browser-policy step beside the rest of a first lock / an unlock: it is its own program and touches only the
# registry policies and Firefox's files, nothing the other steps use, so the two halves take the time of the
# longer one. Policy-Start starts it, Policy-Wait gives its output; if it cannot be started beside, it runs
# when waited for, as before.
function Policy-Start($verb) {
  if (-not (Test-Path $Policy)) { return $null }
  try {
    $si = New-Object Diagnostics.ProcessStartInfo
    $si.FileName = "powershell.exe"; $si.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Policy`" $verb"
    $si.UseShellExecute = $false; $si.RedirectStandardOutput = $true; $si.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($si)
    return @{ p = $p; out = $p.StandardOutput.ReadToEndAsync() }
  } catch { return $null }
}
function Policy-Wait($h, $verb) {
  if (-not $h) { return (Policy $verb) }
  try { $h.p.WaitForExit(); return (([string]$h.out.Result) -replace "`r", "").TrimEnd() } catch { return (Policy $verb) } finally { try { $h.p.Dispose() } catch { } }
}
$script:LqSw = [Diagnostics.Stopwatch]::StartNew()
function Lap([string]$n) { if ($env:LOCKQZ_TIMING) { Write-Host ("TIMING {0,-10} {1,6:N1} s" -f $n, $script:LqSw.Elapsed.TotalSeconds) } }
function Do-Lock {
  Use-Exam   # this exam's lists (the professor's rules), before every layer below reads them
  if ((Is-Locked) -and -not (Block-Intact)) {
    # Markers kept, AI lines deleted (admin edit): rewrite the block whole.
    $wrote = Write-Hosts ((Remove-Block (Read-Hosts)) + ((Get-HostsLines (Get-Domains)) -join "`r`n") + "`r`n") $false
    ipconfig /flushdns | Out-Null
    if (-not $wrote) { "LOCKqz: LOCK FAILED (edited hosts block could not be rewritten)"; return }
  }
  if (Is-Locked) {
    Lap "start"
    Kill-AiAndTools
    Lap "apps"
    Ensure-FirewallRules   # rules removed mid-quiz come back (admin-only to remove, but cheap to re-check)
    Lap "firewall"
    Wild-On; Warm-Apply
    Lap "names+warm"
    # Policies removed by hand mid-quiz -> put them back (browser-policy keeps the first backup).
    if ((Get-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Google\Chrome").LOCKqzManaged -ne 1) { Policy "lock" | Out-Null }
    Lap "policy"
    "LOCKqz: LOCKED (re-applied, apps re-closed)"; return
  }
  New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
  if (-not (Test-Path $Backup)) { Copy-Item $Hosts $Backup -Force }
  Lap "start"
  # Browser AI + AI search answers + extensions off, Windows Copilot/Recall/Click to Do off (quiz only): started
  # now, beside the steps below, and waited for before the AI apps are closed.
  $polRun = Policy-Start "lock"
  $wrote = Write-Hosts ("`r`n" + ((Get-HostsLines (Get-Domains)) -join "`r`n") + "`r`n") $true
  Lap "hosts"
  ipconfig /flushdns | Out-Null
  Lap "flushdns"

  # Firewall backup: DoT/DoQ + known DoH resolvers, local AI model servers, VPN protocols.
  Ensure-FirewallRules
  Lap "firewall"
  # Wildcard AI domains (NRPT) + connections already open to AI hosts.
  Wild-On; Warm-Apply
  Lap "names+warm"

  $pol = Policy-Wait $polRun "lock"
  if ($env:LOCKQZ_TIMING) { "$pol" -split "`n" | Where-Object { $_ -match '^TIMING' } | ForEach-Object { Write-Host $_ } }
  Lap "policy"

  Kill-AiAndTools
  Lap "apps"
  if ($pol -match "FAILED") { "LOCKqz: browser policy not applied ($pol)" }
  if ($wrote -and (Is-Locked) -and $TestMode) { "LOCKqz: LOCKED (test: AI apps, overlays and local models closed; Windows Copilot/Recall off)" }
  elseif ($wrote -and (Is-Locked)) { "LOCKqz: LOCKED (AI apps, VPNs, VMs, remote-desktop, overlays and local models closed; Windows Copilot/Recall off)" }
  else { "LOCKqz: LOCK FAILED (the hosts file could not be written)" }
}

function Do-Unlock {
  $wrote = $true
  # The professor's per-quiz assistive-tool allowance and exam rules end with the lock (every unlock path runs here).
  Remove-Item -LiteralPath "$StateDir\assist.json" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $RulesFile -Force -ErrorAction SilentlyContinue
  Clear-Exam
  Lap "start"
  # Restores exactly the policy values that were there before the quiz (nothing if none were changed): started
  # now, beside the steps below.
  $polRun = Policy-Start "unlock"
  if (Is-Locked) {
    $wrote = Write-Hosts (Remove-Block (Read-Hosts)) $false
    ipconfig /flushdns | Out-Null
  }
  Lap "hosts"
  Get-NetFirewallRule -DisplayName "$FwTag-*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  Lap "firewall"
  Wild-Off; Warm-Clear
  Lap "names+warm"
  $pol = Policy-Wait $polRun "unlock"
  if ($env:LOCKQZ_TIMING) { "$pol" -split "`n" | Where-Object { $_ -match '^TIMING' } | ForEach-Object { Write-Host $_ } }
  Lap "policy"
  if ($pol -match "incomplete") { "LOCKqz: policy restore pending ($pol)" }
  $still = Is-Locked
  if ($env:LOCKQZ_TIMING) { Write-Host ("TIMING hosts written={0} block still there={1} {2}" -f $wrote, $still, $script:HostsWhy) }
  if ($wrote -and -not $still) { "LOCKqz: UNLOCKED" } else { "LOCKqz: UNLOCK FAILED (the hosts file could not be written)" }
}

switch ($cmd) {
  "lock"   { Do-Lock }
  "test"   { Do-Lock }
  "unlock" { Do-Unlock }
  "status" { if (Is-Locked) { "LOCKqz: LOCKED" } else { "LOCKqz: unlocked" } }
  "warm"   { try { Warm-Resolve } finally { Remove-Item -LiteralPath "$WarmFile.refreshing" -Force -ErrorAction SilentlyContinue } }
}
