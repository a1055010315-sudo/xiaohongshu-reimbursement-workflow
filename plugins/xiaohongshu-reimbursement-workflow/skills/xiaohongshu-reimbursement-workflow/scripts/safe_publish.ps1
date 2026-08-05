param(
    [Parameter(Mandatory = $true)][string]$BaselinePath,
    [Parameter(Mandatory = $true)][string]$CandidatePath,
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [Parameter(Mandatory = $true)][string]$ExpectedBaselineSha256,
    [Parameter(Mandatory = $true)][string]$ExpectedCandidateSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-Hash([string]$Value) {
    $normalized = $Value.Trim().ToUpperInvariant()
    if ($normalized -notmatch "^[0-9A-F]{64}$") {
        throw "Expected SHA256 must contain exactly 64 hexadecimal characters."
    }
    return $normalized
}

function Get-StreamSha256([System.IO.Stream]$Stream) {
    $originalPosition = $Stream.Position
    try {
        $Stream.Position = 0
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $sha.ComputeHash($Stream)
            return ([System.BitConverter]::ToString($bytes)).Replace("-", "")
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $Stream.Position = $originalPosition
    }
}

function Get-PathSha256([string]$Path) {
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        return Get-StreamSha256 $stream
    }
    finally {
        $stream.Dispose()
    }
}

function ConvertTo-AsciiJson([object]$Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 6
    $builder = New-Object System.Text.StringBuilder
    foreach ($character in $json.ToCharArray()) {
        $code = [int][char]$character
        if ($code -gt 127) {
            [void]$builder.Append(("\u{0:X4}" -f $code))
        }
        else {
            [void]$builder.Append($character)
        }
    }
    return $builder.ToString()
}

$baselineStream = $null
$candidateStream = $null
$lockStream = $null
$lockOwned = $false
$lockPath = $null
$tempPath = $null
$backupPath = $null
$failedPath = $null
$target = $TargetPath
$publishedHash = $null
$publishStatus = $null
$primaryError = $null
$rollbackError = $null
$preservedBackup = $null
$cleanupErrors = New-Object System.Collections.Generic.List[string]

try {
    $baseline = [System.IO.Path]::GetFullPath($BaselinePath)
    $candidate = [System.IO.Path]::GetFullPath($CandidatePath)
    $target = [System.IO.Path]::GetFullPath($TargetPath)
    $expectedBaseline = Normalize-Hash $ExpectedBaselineSha256
    $expectedCandidate = Normalize-Hash $ExpectedCandidateSha256

    if (-not [System.IO.File]::Exists($baseline)) {
        throw "Baseline file does not exist."
    }
    if (-not [System.IO.File]::Exists($candidate)) {
        throw "Candidate file does not exist."
    }
    if ([string]::Equals($candidate, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Candidate and target paths must be different."
    }

    $targetDirectory = [System.IO.Path]::GetDirectoryName($target)
    if (-not [System.IO.Directory]::Exists($targetDirectory)) {
        throw "Target directory does not exist."
    }

    $lockPath = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish.lock")
    try {
        $lockStream = [System.IO.File]::Open(
            $lockPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $lockOwned = $true
        $lockBytes = [System.Text.Encoding]::ASCII.GetBytes([System.Guid]::NewGuid().ToString("N"))
        $lockStream.Write($lockBytes, 0, $lockBytes.Length)
        $lockStream.Flush($true)
    }
    catch {
        throw "Could not acquire the same-directory publish lock. Another workflow may be publishing or a stale lock may require inspection. Lock: $lockPath"
    }

    $targetExisted = [System.IO.File]::Exists($target)
    if ($targetExisted -and -not [string]::Equals($baseline, $target, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "When the target exists, BaselinePath must be the target path."
    }

    $baselineStream = [System.IO.File]::Open(
        $baseline,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    $candidateStream = [System.IO.File]::Open(
        $candidate,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )

    $baselineHash = Get-StreamSha256 $baselineStream
    $candidateHash = Get-StreamSha256 $candidateStream
    if ($baselineHash -ne $expectedBaseline) {
        throw "Baseline SHA256 changed before publish."
    }
    if ($candidateHash -ne $expectedCandidate) {
        throw "Candidate SHA256 changed before publish."
    }

    if ($targetExisted -and $baselineHash -eq $candidateHash) {
        $publishedHash = $candidateHash
        $publishStatus = "already_current"
    }
    else {
        $token = [System.Guid]::NewGuid().ToString("N")
        $tempPath = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-publish-$token.tmp")
        $backupPath = [System.IO.Path]::Combine($targetDirectory, ".codex-xhs-backup-$token.tmp")

        $candidateStream.Position = 0
        $tempStream = [System.IO.File]::Open(
            $tempPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $candidateStream.CopyTo($tempStream)
            $tempStream.Flush($true)
        }
        finally {
            $tempStream.Dispose()
        }

        if ((Get-PathSha256 $tempPath) -ne $expectedCandidate) {
            throw "Verified publish copy does not match the candidate SHA256."
        }
        if ((Get-StreamSha256 $baselineStream) -ne $expectedBaseline) {
            throw "Baseline SHA256 changed immediately before publish."
        }
        if ((Get-StreamSha256 $candidateStream) -ne $expectedCandidate) {
            throw "Candidate SHA256 changed immediately before publish."
        }

        $baselineStream.Dispose()
        $baselineStream = $null

        if ($targetExisted) {
            if (-not [System.IO.File]::Exists($target)) {
                throw "Target disappeared immediately before replace."
            }
            if ((Get-PathSha256 $target) -ne $expectedBaseline) {
                throw "Target path SHA256 changed immediately before replace."
            }
            [System.IO.File]::Replace($tempPath, $target, $backupPath, $true)
            $publishStatus = "replaced"
        }
        else {
            if ([System.IO.File]::Exists($target)) {
                throw "Target appeared immediately before first publish."
            }
            if ((Get-PathSha256 $baseline) -ne $expectedBaseline) {
                throw "Baseline path SHA256 changed immediately before first publish."
            }
            [System.IO.File]::Move($tempPath, $target)
            $publishStatus = "created"
        }
        $tempPath = $null

        $publishedHash = Get-PathSha256 $target
        if ($publishedHash -ne $expectedCandidate) {
            throw "Published target SHA256 does not match the candidate."
        }
    }
}
catch {
    $primaryError = $_.Exception.Message
    if ($backupPath -and [System.IO.File]::Exists($backupPath)) {
        if ([System.IO.File]::Exists($target)) {
            try {
                $rollbackToken = [System.Guid]::NewGuid().ToString("N")
                $rollbackDirectory = [System.IO.Path]::GetDirectoryName($target)
                $failedPath = [System.IO.Path]::Combine($rollbackDirectory, ".codex-xhs-failed-$rollbackToken.tmp")
                [System.IO.File]::Replace($backupPath, $target, $failedPath, $true)
                $backupPath = $null
            }
            catch {
                $rollbackError = $_.Exception.Message
                $preservedBackup = $backupPath
            }
        }
        else {
            $rollbackError = "Target is missing; automatic rollback was not attempted."
            $preservedBackup = $backupPath
        }
    }
}
finally {
    if ($candidateStream) {
        try { $candidateStream.Dispose() } catch { $cleanupErrors.Add("candidate stream: " + $_.Exception.Message) }
    }
    if ($baselineStream) {
        try { $baselineStream.Dispose() } catch { $cleanupErrors.Add("baseline stream: " + $_.Exception.Message) }
    }
    if ($tempPath -and [System.IO.File]::Exists($tempPath)) {
        try { [System.IO.File]::Delete($tempPath) } catch { $cleanupErrors.Add("temporary publish file: " + $_.Exception.Message) }
    }
    if (-not $primaryError -and $backupPath -and [System.IO.File]::Exists($backupPath)) {
        try {
            [System.IO.File]::Delete($backupPath)
            $backupPath = $null
        }
        catch {
            $cleanupErrors.Add("verified backup file: " + $_.Exception.Message)
        }
    }
    if ($failedPath -and [System.IO.File]::Exists($failedPath)) {
        try { [System.IO.File]::Delete($failedPath) } catch { $cleanupErrors.Add("failed replacement copy: " + $_.Exception.Message) }
    }
    if ($lockStream) {
        try { $lockStream.Dispose() } catch { $cleanupErrors.Add("publish lock stream: " + $_.Exception.Message) }
    }
    if ($lockOwned -and $lockPath -and [System.IO.File]::Exists($lockPath)) {
        try { [System.IO.File]::Delete($lockPath) } catch { $cleanupErrors.Add("publish lock file: " + $_.Exception.Message) }
    }
}

if ($primaryError) {
    $result = [pscustomobject]@{
        ok = $false
        status = "publish_failed"
        error = $primaryError
        rollback_error = $rollbackError
        preserved_backup = $preservedBackup
        cleanup_errors = $cleanupErrors.ToArray()
        target = $target
    }
    $exitCode = 1
}
elseif ($cleanupErrors.Count -gt 0) {
    $result = [pscustomobject]@{
        ok = $false
        status = "published_cleanup_failed"
        error = "The target was verified, but one or more exact temporary paths could not be cleaned."
        cleanup_errors = $cleanupErrors.ToArray()
        target = $target
        sha256 = $publishedHash
    }
    $exitCode = 1
}
else {
    $result = [pscustomobject]@{
        ok = $true
        status = $publishStatus
        target = $target
        sha256 = $publishedHash
    }
    $exitCode = 0
}

Write-Output (ConvertTo-AsciiJson $result)
exit $exitCode
