<#
.SYNOPSIS
    AI Engineering OS - ERP Genome Extractor (Optimized for Tokens)
.DESCRIPTION
    يقرأ هيكل الـ ERP، يستخرج الـ Schema والمفاتيح الأجنبية، ويبني مخططات Mermaid بدون استنزاف التوكنز.
#>
param(
    [Parameter(Mandatory=$true)][string]$ProjectPath,
    [string]$OutputFile = "ERP_GENOME.md",
    # "resources"/"postgres" drop the vendored PostgreSQL bundle under
    # desktop/src-tauri/resources, which ships PostgreSQL's own catalog SQL.
    [string[]]$ExcludeDirs = @("node_modules", "dist", "build", ".git", "vendor", "coverage", ".next", "target", "resources", "postgres")
)

$ProjectPath = (Resolve-Path $ProjectPath).Path
$OutPath = Join-Path (Get-Location) $OutputFile
$sb = [System.Text.StringBuilder]::new()

function Write-Out ([string]$text) {
    [void]$sb.AppendLine($text)
}

function Test-Excluded ([string]$path) {
    foreach ($dir in $ExcludeDirs) {
        if ($path -match "\\$dir(\\)?") { return $true }
    }
    return $false
}

$Singleline = [System.Text.RegularExpressions.RegexOptions]::Singleline
$IgnoreCase = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase

# System schemas / pseudo-tables that must never enter the ER diagram.
$IgnoredEntities = @("public", "pg_catalog", "information_schema", "pg_temp")

Write-Host "[1/5] بدء استخراج جينوم مشروع ERP الموفر للتوكنز..." -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. Header
Write-Out "# ERP Project Genome & Architecture Blueprint"
Write-Out "**تاريخ الاستخراج:** $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Out "**مسار المشروع:** $ProjectPath"
Write-Out "> **توجيه للوكيل:** هذا الملف يمثل خريطة وهيكل النظام فقط. التزم بقراءته دون طلب فحص الملفات الأصلية إلا للضرورة القصوى."
Write-Out "---"

# ------------------------------------------------------- 2. Directory tree
Write-Host "[2/5] استخراج شجرة المجلدات..." -ForegroundColor Yellow
Write-Out "## 1. شجرة مجلدات المشروع (Directory Structure)"
Write-Out '```text'
$tree = @(Get-ChildItem -Path $ProjectPath -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Excluded $_.FullName) })
foreach ($dir in $tree) {
    $relativePath = $dir.FullName.Replace($ProjectPath, "")
    $depth = ($relativePath.Split([IO.Path]::DirectorySeparatorChar)).Count - 1
    $indent = "  " * $depth
    Write-Out "$indent|-- $($dir.Name)/"
}
Write-Out '```'
Write-Out "---"

# ------------------------------------------------------------ 3. ER diagram
Write-Host "[3/5] تحليل الجداول والعلاقات المحاسبية..." -ForegroundColor Yellow
Write-Out "## 2. مخطط قاعدة البيانات والعلاقات (ER Diagram)"

$sqlFiles = @(Get-ChildItem -Path $ProjectPath -Recurse -Include "*.sql" -File -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Excluded $_.FullName) })
$tsFiles = @(Get-ChildItem -Path $ProjectPath -Recurse -Include "*.ts", "*.tsx" -File -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Excluded $_.FullName) })

# --- SQL grammar ---
$rxCreateTable = [regex]::new(
    'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["''`\[]?([a-zA-Z_][a-zA-Z0-9_]*)["''`\]]?\s*\((.*?)\n\)\s*;',
    ($IgnoreCase -bor $Singleline))
$rxAlterFk = [regex]::new(
    'ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+|ONLY\s+)?["''`\[]?([a-zA-Z_][a-zA-Z0-9_]*)["''`\]]?\s+ADD\s+(?:CONSTRAINT\s+[^\s]+\s+)?FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+["''`\[]?([a-zA-Z_][a-zA-Z0-9_]*)',
    ($IgnoreCase -bor $Singleline))
$rxRefColumn = [regex]::new('REFERENCES\s+["''`\[]?([a-zA-Z_][a-zA-Z0-9_]*)', $IgnoreCase)

# --- Drizzle grammar ---
$rxPgTableDecl = [regex]::new('export\s+const\s+([a-zA-Z0-9_]+)\s*=\s*pgTable\(\s*["'']([a-zA-Z0-9_]+)["'']')
$rxPgTableAny = [regex]::new('pgTable\(\s*["'']([a-zA-Z0-9_]+)["'']')
$rxPgRef = [regex]::new('\.\s*references\(\s*\(\s*\)\s*=>\s*([a-zA-Z0-9_]+)\s*\.')
$rxNamedImport = [regex]::new('import\s*\{([^}]*)\}\s*from\s*["'']([^"'']+)["'']')
$rxExportAll = [regex]::new('export\s+(?:\*|\{[^}]*\})\s+from\s*["'']([^"'']+)["'']')

$entities = [System.Collections.Generic.SortedSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$relations = [System.Collections.Generic.SortedSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

function Add-Relation ([string]$child, [string]$parent) {
    if (-not $child -or -not $parent) { return }
    if ($IgnoredEntities -contains $child.ToLowerInvariant()) { return }
    if ($IgnoredEntities -contains $parent.ToLowerInvariant()) { return }
    if ($child -eq $parent) { return }
    [void]$entities.Add($child)
    [void]$entities.Add($parent)
    [void]$relations.Add(('{0}||--o{{ {1}' -f $parent, $child))
}

# Pass 1: SQL migrations -> entities + inline/added foreign keys.
$sqlTables = @{}
foreach ($file in $sqlFiles) {
    $content = Get-Content $file.FullName -Raw
    if (-not $content) { continue }
    foreach ($m in $rxCreateTable.Matches($content)) {
        $table = $m.Groups[1].Value
        if ($IgnoredEntities -contains $table.ToLowerInvariant()) { continue }
        [void]$entities.Add($table)
        if (-not $sqlTables.ContainsKey($table)) { $sqlTables[$table] = @{} }
        foreach ($col in $rxRefColumn.Matches($m.Groups[2].Value)) {
            $sqlTables[$table][$col.Groups[1].Value] = $true
        }
    }
    foreach ($m in $rxAlterFk.Matches($content)) {
        Add-Relation -child $m.Groups[1].Value -parent $m.Groups[2].Value
    }
}

# Pass 2: Drizzle table files -> export symbol -> physical table name.
$symbolToTable = @{}
foreach ($file in $tsFiles) {
    $content = Get-Content $file.FullName -Raw
    if (-not $content) { continue }
    foreach ($m in $rxPgTableDecl.Matches($content)) {
        $symbolToTable["$($file.FullName)|$($m.Groups[1].Value)"] = $m.Groups[2].Value
    }
}

function Resolve-TableName {
    param([string]$FilePath, [string]$Symbol, [int]$Depth = 0)
    if ($Depth -gt 3 -or -not $Symbol) { return $null }
    $key = "$FilePath|$Symbol"
    if ($symbolToTable.ContainsKey($key)) { return $symbolToTable[$key] }
    $content = Get-Content $FilePath -Raw -ErrorAction SilentlyContinue
    if (-not $content) { return $null }
    $dir = [IO.Path]::GetDirectoryName($FilePath)
    foreach ($block in @($rxNamedImport.Matches($content), $rxExportAll.Matches($content))) {
        foreach ($m in $block) {
            if ($block -eq $rxExportAll -or $true) {
                $spec = $m.Groups[$m.Groups.Count - 1].Value
                if ($spec -notmatch '^\.') { continue }
                $resolved = [IO.Path]::GetFullPath((Join-Path $dir $spec))
                foreach ($ext in @(".ts", ".tsx", ".js")) {
                    if ($resolved.EndsWith($ext)) { $resolved = $resolved.Substring(0, $resolved.Length - $ext.Length) }
                }
                foreach ($candidate in @("$resolved.ts", "$resolved.tsx", "$resolved.index.ts", "$resolved.ts" )) {
                    if (Test-Path $candidate) {
                        $hit = Resolve-TableName -FilePath $candidate -Symbol $Symbol -Depth ($Depth + 1)
                        if ($hit) { return $hit }
                    }
                }
            }
        }
    }
    return $null
}

# Pass 3: Drizzle foreign keys.
foreach ($file in $tsFiles) {
    $content = Get-Content $file.FullName -Raw
    if (-not $content) { continue }
    $own = $rxPgTableDecl.Match($content)
    if (-not $own.Success) { continue }
    $child = $own.Groups[2].Value
    [void]$entities.Add($child)
    foreach ($m in $rxPgRef.Matches($content)) {
        $symbol = $m.Groups[1].Value
        $parent = Resolve-TableName -FilePath $file.FullName -Symbol $symbol
        if ($parent) { Add-Relation -child $child -parent $parent }
    }
}

Write-Out '```mermaid'
Write-Out 'erDiagram'
foreach ($entity in $entities) { Write-Out ('    {0} {{ string id }}' -f $entity) }
foreach ($relation in $relations) { Write-Out ('    {0} : references' -f $relation) }
Write-Out '```'
Write-Out "**عدد الجداول:** $($entities.Count) | **عدد العلاقات:** $($relations.Count)"
Write-Out "---"

# ------------------------------------------------------- 4. Dependency graph
Write-Host "[4/5] تحليل شجرة الاعتماديات..." -ForegroundColor Yellow
Write-Out "## 3. خريطة ترابط الخدمات والـ Imports (علاقات داخلية فقط)"
Write-Out '```mermaid'
Write-Out 'graph TD'

$srcFiles = @(Get-ChildItem -Path $ProjectPath -Recurse -Include "*.ts", "*.tsx", "*.js", "*.mjs", "*.php", "*.go" -File -ErrorAction SilentlyContinue |
    Where-Object { -not (Test-Excluded $_.FullName) })

$rxRelativeImport = [regex]::new('(?:import|export)\s[^;''"]*from\s*["'']([./][^"'']+)["'']|require\(\s*["'']([./][^"'']+)["'']')
$edges = [System.Collections.Generic.HashSet[string]]::new()
$maxEdges = 80

foreach ($file in $srcFiles) {
    if ($edges.Count -ge $maxEdges) { break }
    $sourceName = $file.BaseName -replace '[^a-zA-Z0-9]', '_'
    $dir = [IO.Path]::GetDirectoryName($file.FullName)
    foreach ($line in (Get-Content $file.FullName -ErrorAction SilentlyContinue)) {
        if ($edges.Count -ge $maxEdges) { break }
        $m = $rxRelativeImport.Match($line)
        if (-not $m.Success) { continue }
        $spec = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
        $base = [IO.Path]::GetFileName($spec) -replace '\.(ts|tsx|js|mjs|php|go)$', ''
        if ($base -eq 'index' -or $base -eq $sourceName -or $base.Length -le 2) { continue }
        [void]$edges.Add(('    {0} --> {1}' -f $sourceName, ($base -replace '[^a-zA-Z0-9]', '_')))
    }
}
foreach ($edge in ($edges | Sort-Object)) { Write-Out $edge }
if ($edges.Count -ge $maxEdges) {
    Write-Out ('    %% تم إيقاف الاعتماديات عند {0} رابطا لتوفير السياق' -f $maxEdges)
}
Write-Out '```'
Write-Out "---"

# ------------------------------------------------------------ 5. Signatures
Write-Host "[5/5] استخراج التواقيع البرمجية للملفات الحساسة فقط..." -ForegroundColor Yellow
Write-Out "## 4. هياكل وتواقيع الكود الحساس (Services & Controllers Signatures)"

$rxSig = [regex]::new('^\s*(export\s+)?(abstract\s+)?(class|interface|type|enum|async\s+function|function|public|private|protected)\s+[a-zA-Z0-9_]+')
$coreFiles = @($srcFiles | Where-Object { $_.Name -match "(Controller|Service|Repository|UseCase)\.(ts|tsx|js|mjs)$" } | Sort-Object FullName)
foreach ($file in $coreFiles) {
    $relativePath = $file.FullName.Replace($ProjectPath, "")
    Write-Out "### ملف: ``$relativePath``"
    Write-Out '```typescript'
    foreach ($line in (Get-Content $file.FullName -ErrorAction SilentlyContinue)) {
        if ($rxSig.IsMatch($line)) { Write-Out $line }
    }
    Write-Out '```'
}

Set-Content -Path $OutPath -Value $sb.ToString() -Encoding UTF8

Write-Host "[5/5] تم الانتهاء بنجاح: $OutPath" -ForegroundColor Green
Write-Host ("المجلدات: {0} | ملفات SQL: {1} | ملفات TS: {2} | الجداول: {3} | العلاقات: {4} | روابط الاعتماديات: {5} | ملفات التواقيع: {6}" -f `
    $tree.Count, $sqlFiles.Count, $tsFiles.Count, $entities.Count, $relations.Count, $edges.Count, $coreFiles.Count)
