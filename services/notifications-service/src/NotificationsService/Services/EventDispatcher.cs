using Google.Protobuf;
using Microsoft.Extensions.DependencyInjection;
using NATS.Client;
using NotificationsService.Handlers;

namespace NotificationsService.Services;

public class EventDispatcher(
    IServiceProvider serviceProvider,
    INatsPublisher publisher,
    IConfiguration config,
    ILogger<EventDispatcher> logger)
{
    public async Task DispatchAsync(Msg msg, CancellationToken ct)
    {
        logger.LogInformation("Dispatching event from subject {Subject}, size={Size} bytes",
            msg.Subject, msg.Data.Length);

        using var scope = serviceProvider.CreateScope();

        var handlers = scope.ServiceProvider.GetServices<IEventHandler>().ToList();
        if (handlers.Count == 0)
        {
            logger.LogDebug("No handlers registered for subject {Subject}", msg.Subject);
            return;
        }

        logger.LogDebug("Found {Count} handlers for subject {Subject}", handlers.Count, msg.Subject);

        var handledCount = 0;
        foreach (var handler in handlers)
        {
            var handlerType = handler.GetType().Name;

            try
            {
                var canHandle = handler.CanHandle(msg);
                logger.LogDebug("Handler {HandlerType} CanHandle={Result}", handlerType, canHandle);

                if (!canHandle)
                {
                    continue;
                }

                handledCount++;
                var commands = await handler.HandleAsync(msg, ct);
                var commandList = commands.ToList();

                logger.LogInformation("Handler {HandlerType} produced {Count} commands", handlerType, commandList.Count);

                foreach (var command in commandList)
                {
                    await PublishCommandAsync(command, ct);
                }
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Handler {HandlerType} failed to process event", handlerType);
            }
        }

        logger.LogInformation("Event processing complete: {HandlerCount} handlers executed", handledCount);
    }

    private async Task PublishCommandAsync(IMessage command, CancellationToken ct)
    {
        var commandType = command.GetType().Name;
        var subject = GetSubjectForCommand(commandType);

        if (subject == null)
        {
            logger.LogError("No subject mapping found for command type {CommandType}", commandType);
            return;
        }

        try
        {
            await publisher.PublishAsync(subject, command, ct);
            logger.LogDebug("Published command {CommandType} to subject {Subject}", commandType, subject);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to publish command {CommandType} to subject {Subject}",
                commandType, subject);
        }
    }

    private string? GetSubjectForCommand(string commandType)
    {
        var mappings = config.GetSection("Nats:Subjects:CommandMappings");
        return mappings[commandType];
    }
}

