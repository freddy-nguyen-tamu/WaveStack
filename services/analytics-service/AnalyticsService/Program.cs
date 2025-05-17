using AnalyticsService;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var calculator = new AnalyticsCalculator();

app.MapGet("/health", () => Results.Ok(new { status = "ok", service = "analytics-service" }));

app.MapPost("/plays", (PlayEvent playEvent) =>
{
    calculator.RecordPlay(playEvent);
    return Results.Accepted();
});

app.MapGet("/trending", () => Results.Ok(calculator.GetTrendingSongs()));
app.MapGet("/admin/reports/daily", () => Results.Ok(calculator.GetDailyReport()));
app.MapGet("/internal/metrics", () => Results.Ok(calculator.GetInternalMetrics()));

app.Run();

public partial class Program;
