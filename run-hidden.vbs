' run-hidden.vbs — מריץ את שרת MoneySaver ללא חלון, וממתין לו (לצורך התאוששות מקריסה).
' מפנה stdout+stderr ל-logs\server.log כדי שאפשר יהיה לדבג נפילות (בעבר הפלט אבד).
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
logDir  = baseDir & "\logs"
logFile = logDir & "\server.log"

If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
' rotation פשוט: אם הלוג עבר 5MB — מוחקים, כדי שלא יגדל ללא הגבלה
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then fso.DeleteFile(logFile)
End If

' חותמת התחלה לכל ריצה — מזהה restart/קריסה בציר הזמן
Set ts = fso.OpenTextFile(logFile, 8, True) ' 8 = append, True = create
ts.WriteLine "===== התחלת ריצה " & Now & " ====="
ts.Close

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = baseDir
' 0 = חלון מוסתר, True = להמתין עד שהתהליך מסתיים. cmd /c לצורך ה-redirect.
' חשוב: "server/index.js" ב-forward slash — כך ה-CommandLine תואם את פילטרי ההריגה
' הכירורגית (CLAUDE.md, watchdog.js). backslash היה שובר את הזיהוי ומשאיר יתומים.
exitCode = sh.Run("cmd /c node server/index.js >> ""logs\server.log"" 2>&1", 0, True)
WScript.Quit exitCode
