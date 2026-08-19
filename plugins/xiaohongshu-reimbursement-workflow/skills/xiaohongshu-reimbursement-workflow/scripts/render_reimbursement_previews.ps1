param(
  [Parameter(Mandatory = $true)][string]$RequestPath,
  [Parameter(Mandatory = $true)][string]$RequestSha256,
  [Parameter(Mandatory = $true)][string]$RequestNonce
)

$ErrorActionPreference = "Stop"
$MaxRequestBytes = 1MB
$MaxJobs = 36
$AllowedProfiles = @("xiaohongshu", "company", "residence")
$AllowedRoles = @("root", "detail", "screenshot")

function Assert-ExactKeys {
  param([object]$Value, [string[]]$Keys, [string]$Field)
  if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw "$Field must be an object." }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Keys | Sort-Object)
  if (($actual -join "`0") -cne ($expected -join "`0")) { throw "$Field has invalid fields." }
}

function Assert-CleanText {
  param([object]$Value, [string]$Field)
  if ($Value -isnot [string] -or $Value.Length -lt 1 -or $Value -cne $Value.Trim() -or $Value -match '[\r\n\t]') {
    throw "$Field must be clean non-empty text."
  }
  return [string]$Value
}

function Assert-Sha256 {
  param([object]$Value, [string]$Field)
  $text = Assert-CleanText $Value $Field
  if ($text -cnotmatch '^[0-9a-f]{64}$') { throw "$Field must be a lowercase SHA-256 digest." }
  return $text
}

function Convert-ColumnNumber {
  param([string]$Column)
  [long]$result = 0
  foreach ($character in $Column.ToCharArray()) { $result = $result * 26 + ([int][char]$character - [int][char]'A' + 1) }
  return $result
}

function Parse-CellRange {
  param([object]$Value, [string]$Field)
  $address = Assert-CleanText $Value $Field
  $match = [regex]::Match($address, '^([A-Z]{1,3})([1-9][0-9]*):([A-Z]{1,3})([1-9][0-9]*)$')
  if (-not $match.Success) { throw "$Field must be an uppercase rectangular A1 range." }
  [long]$startColumn = Convert-ColumnNumber $match.Groups[1].Value
  [long]$startRow = 0
  [long]$endColumn = Convert-ColumnNumber $match.Groups[3].Value
  [long]$endRow = 0
  if (-not [long]::TryParse($match.Groups[2].Value, [ref]$startRow) -or -not [long]::TryParse($match.Groups[4].Value, [ref]$endRow)) {
    throw "$Field contains an invalid row number."
  }
  if ($startColumn -lt 1 -or $endColumn -gt 16384 -or $startRow -lt 1 -or $endRow -gt 1048576 -or $startColumn -gt $endColumn -or $startRow -gt $endRow) {
    throw "$Field is outside Excel bounds or has its start after its end."
  }
  return [pscustomobject]@{ Address = $address; StartColumn = $startColumn; StartRow = $startRow; EndColumn = $endColumn; EndRow = $endRow }
}

function Get-LowerSha256 {
  param([string]$Path)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Release-ComObject {
  param([object]$Value)
  if ($null -ne $Value) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value) }
}

if (-not ("CodexPreviewNativeMethods" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CodexPreviewNativeMethods {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
}

if (-not [IO.Path]::IsPathRooted($RequestPath)) { throw "Renderer request path must be absolute." }
$resolvedRequest = [IO.Path]::GetFullPath($RequestPath)
if ($RequestSha256 -cnotmatch '^[0-9a-f]{64}$' -or $RequestNonce -cnotmatch '^[0-9a-f]{64}$') { throw "Renderer request binding is invalid." }
$requestInfo = Get-Item -LiteralPath $resolvedRequest -Force
if ($requestInfo.PSIsContainer -or ($requestInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $requestInfo.Length -lt 1 -or $requestInfo.Length -gt $MaxRequestBytes) {
  throw "Renderer request must be a bounded regular file."
}
$requestBytes = [IO.File]::ReadAllBytes($resolvedRequest)
if ((Get-LowerSha256 $resolvedRequest) -cne $RequestSha256) { throw "Renderer request SHA-256 differs from the parent binding." }
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$request = $utf8.GetString($requestBytes) | ConvertFrom-Json
Assert-ExactKeys $request @("kind", "requestNonce", "outputRoot", "affectedProfileIds", "previewScopes", "jobs") "request"
if ($request.kind -cne "ordinary-reimbursement-preview-request-v1" -or $request.requestNonce -cne $RequestNonce) {
  throw "Renderer request identity differs from the parent binding."
}
if ($request.jobs -isnot [array] -or $request.previewScopes -isnot [array] -or $request.jobs.Count -lt 3 -or $request.jobs.Count -gt $MaxJobs -or $request.previewScopes.Count -ne $request.jobs.Count) {
  throw "Renderer request must contain matching bounded job and preview-scope arrays."
}
if ($request.affectedProfileIds -isnot [array] -or $request.affectedProfileIds.Count -lt 1 -or $request.affectedProfileIds.Count -gt 3) {
  throw "Renderer request affectedProfileIds is invalid."
}

$declaredProfiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($rawProfileId in $request.affectedProfileIds) {
  $profileId = Assert-CleanText $rawProfileId "request.affectedProfileIds"
  if ($AllowedProfiles -cnotcontains $profileId -or -not $declaredProfiles.Add($profileId)) { throw "Renderer request affectedProfileIds is invalid." }
}
$outputRootText = Assert-CleanText $request.outputRoot "request.outputRoot"
if (-not [IO.Path]::IsPathRooted($outputRootText)) { throw "request.outputRoot must be absolute." }
$outputRoot = [IO.Path]::GetFullPath($outputRootText)
$outputRootInfo = Get-Item -LiteralPath $outputRoot -Force
if (-not $outputRootInfo.PSIsContainer -or ($outputRootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Renderer outputRoot must be a plain directory." }

$entries = [Collections.Generic.List[object]]::new()
$seenProfiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$seenIdentities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
$seenOutputs = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
for ($index = 0; $index -lt $request.jobs.Count; $index++) {
  $job = $request.jobs[$index]
  $scope = $request.previewScopes[$index]
  Assert-ExactKeys $job @("profileId", "role", "workbookPath", "workbookSha256", "sheetName", "rangeAddress", "outputPath") "render job[$index]"
  Assert-ExactKeys $scope @("profileId", "role", "sheetName", "rangeAddress", "sourceSha256") "preview scope[$index]"
  $profileId = Assert-CleanText $job.profileId "render job[$index].profileId"
  $role = Assert-CleanText $job.role "render job[$index].role"
  $sheetName = Assert-CleanText $job.sheetName "render job[$index].sheetName"
  $range = Parse-CellRange $job.rangeAddress "render job[$index].rangeAddress"
  $sourceSha256 = Assert-Sha256 $job.workbookSha256 "render job[$index].workbookSha256"
  if ($AllowedProfiles -cnotcontains $profileId -or -not $declaredProfiles.Contains($profileId) -or $AllowedRoles -cnotcontains $role) { throw "Render job profile or role is invalid." }
  if ($sheetName.Length -gt 31 -or $sheetName -match '[\\/:?*\[\]]') { throw "Render job worksheet name is invalid." }
  $scopeProfileId = Assert-CleanText $scope.profileId "preview scope[$index].profileId"
  $scopeRole = Assert-CleanText $scope.role "preview scope[$index].role"
  $scopeSheetName = Assert-CleanText $scope.sheetName "preview scope[$index].sheetName"
  $scopeRange = Parse-CellRange $scope.rangeAddress "preview scope[$index].rangeAddress"
  $scopeSha256 = Assert-Sha256 $scope.sourceSha256 "preview scope[$index].sourceSha256"
  if ($profileId -cne $scopeProfileId -or $role -cne $scopeRole -or $sheetName -cne $scopeSheetName -or $range.Address -cne $scopeRange.Address -or $sourceSha256 -cne $scopeSha256) {
    throw "Preview scope does not match its render job identity."
  }
  $workbookPathText = Assert-CleanText $job.workbookPath "render job[$index].workbookPath"
  $outputPathText = Assert-CleanText $job.outputPath "render job[$index].outputPath"
  if (-not [IO.Path]::IsPathRooted($workbookPathText) -or -not [IO.Path]::IsPathRooted($outputPathText)) { throw "Render paths must be absolute." }
  $workbookPath = [IO.Path]::GetFullPath($workbookPathText)
  $outputPath = [IO.Path]::GetFullPath($outputPathText)
  $outputDirectory = [IO.Path]::GetDirectoryName($outputPath)
  if ($null -eq $outputDirectory -or -not [StringComparer]::OrdinalIgnoreCase.Equals($outputDirectory, $outputRoot) -or -not $seenOutputs.Add($outputPath)) {
    throw "Render output path is outside outputRoot or duplicated."
  }
  $identity = "$profileId`0$role`0$sheetName`0$($range.Address)`0$sourceSha256"
  if (-not $seenIdentities.Add($identity)) { throw "Renderer request contains duplicate preview identities." }
  [void]$seenProfiles.Add($profileId)
  $entries.Add([pscustomobject]@{ ProfileId = $profileId; Role = $role; SheetName = $sheetName; Range = $range; SourceSha256 = $sourceSha256; WorkbookPath = $workbookPath; OutputPath = $outputPath })
}
if ($seenProfiles.Count -ne $declaredProfiles.Count) { throw "Renderer jobs do not exactly match affectedProfileIds." }

$created = [Collections.Generic.List[object]]::new()
$excel = $null
$engineProcess = $null
$enginePeakWorkingSetBytes = 0L
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  [uint32]$enginePid = 0
  [void][CodexPreviewNativeMethods]::GetWindowThreadProcessId([IntPtr]$excel.Hwnd, [ref]$enginePid)
  if ($enginePid -lt 1) { throw "Renderer could not bind the spreadsheet engine process." }
  $engineProcess = [Diagnostics.Process]::GetProcessById([int]$enginePid)
  foreach ($entry in $entries) {
    $workbookInfo = Get-Item -LiteralPath $entry.WorkbookPath -Force
    if ($workbookInfo.PSIsContainer -or ($workbookInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Render source must be a plain workbook file." }
    if (Test-Path -LiteralPath $entry.OutputPath) { throw "Render output path already exists." }
    if ((Get-LowerSha256 $entry.WorkbookPath) -cne $entry.SourceSha256) { throw "Render source changed before open." }
    $book = $null
    $sheet = $null
    $range = $null
    $charts = $null
    $chartObject = $null
    $chart = $null
    try {
      $book = $excel.Workbooks.Open($entry.WorkbookPath, 0, $true)
      $sheet = $book.Worksheets.Item($entry.SheetName)
      $range = $sheet.Range($entry.Range.Address)
      [void]$range.CopyPicture(1, 2)
      $charts = $sheet.ChartObjects()
      $chartObject = $charts.Add(0, 0, [double]$range.Width, [double]$range.Height)
      $chart = $chartObject.Chart
      [void]$chart.Paste()
      [void]$chart.Export($entry.OutputPath, "PNG")
    } finally {
      Release-ComObject $chart
      if ($null -ne $chartObject) { [void]$chartObject.Delete() }
      Release-ComObject $chartObject
      Release-ComObject $charts
      Release-ComObject $range
      Release-ComObject $sheet
      if ($null -ne $book) { $book.Close($false) }
      Release-ComObject $book
    }
    if ((Get-LowerSha256 $entry.WorkbookPath) -cne $entry.SourceSha256) { throw "Render source changed during render." }
    $outputBytes = [IO.File]::ReadAllBytes($entry.OutputPath)
    if ($outputBytes.Length -lt 1000 -or $outputBytes[0] -ne 137 -or $outputBytes[1] -ne 80 -or $outputBytes[2] -ne 78 -or $outputBytes[3] -ne 71) {
      throw "Renderer did not create a valid non-empty PNG."
    }
    $created.Add([pscustomobject]@{ profileId = $entry.ProfileId; role = $entry.Role; workbookSha256 = $entry.SourceSha256; outputPath = $entry.OutputPath; sha256 = Get-LowerSha256 $entry.OutputPath; size = $outputBytes.Length })
    $engineProcess.Refresh()
    $enginePeakWorkingSetBytes = [Math]::Max($enginePeakWorkingSetBytes, [int64]$engineProcess.PeakWorkingSet64)
  }
} finally {
  if ($null -ne $excel) { $excel.Quit() }
  Release-ComObject $excel
}

if ((Get-LowerSha256 $resolvedRequest) -cne $RequestSha256) { throw "Renderer request changed during execution." }
$response = [ordered]@{
  kind = "ordinary-reimbursement-preview-response-v1"
  requestNonce = $RequestNonce
  requestFileSha256 = $RequestSha256
  enginePeakWorkingSetBytes = $enginePeakWorkingSetBytes
  previews = @($created)
}
[Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 5))
