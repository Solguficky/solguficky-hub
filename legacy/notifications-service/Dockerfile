# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY ["legacy/notifications-service/src/NotificationsService/NotificationsService.csproj", "legacy/notifications-service/src/NotificationsService/"]
RUN dotnet restore "legacy/notifications-service/src/NotificationsService/NotificationsService.csproj"

COPY ["legacy/notifications-service/", "legacy/notifications-service/"]
WORKDIR "/src/legacy/notifications-service/src/NotificationsService"

RUN --mount=type=bind,source=contracts,target=/src/contracts \
    dotnet build "NotificationsService.csproj" -c Release -o /app/build

RUN --mount=type=bind,source=contracts,target=/src/contracts \
    dotnet publish "NotificationsService.csproj" -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
EXPOSE 8080

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "NotificationsService.dll"]


